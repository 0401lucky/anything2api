import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  closeBrowserSession,
  generateProjectGroupRevisionViaGraphql,
  openBrowserSession,
  type BrowserSessionHandle,
} from "./browser.js";
import { type AccountSessionRecord } from "./account.js";
import { AccountPool, type PoolAccountRecord } from "./account-pool.js";
import { MetricsRegistry } from "./metrics.js";
import { SUPPORTED_MODEL_IDS, resolveModel } from "./model-catalog.js";
import { cleanAssistantOutput } from "./output-cleaning.js";
import { formatError } from "./util/error.js";
import {
  endSse,
  parseIncrementalOutput,
  setupSse,
  writeAnthropicStart,
  writeAnthropicStop,
  writeAnthropicTextDelta,
  writeAnthropicToolDelta,
  writeOpenAIFinish,
  writeOpenAIChatTextDelta,
  writeOpenAIChatToolCallDelta,
  writeResponsesTextDelta,
  writeResponsesToolCallDelta,
} from "./streaming.js";
import {
  buildToolPrompt,
  extractFinalContent,
  normalizeToolChoice,
  normalizeTools,
  parseToolCallResponse,
  type ParsedToolCall,
} from "./tool-calls.js";
import { checkApiKey, parseApiKeys } from "./auth/api-key.js";
import { UsageTracker } from "./usage/tracker.js";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const ANYTHING_BASE_URL = process.env.ANYTHING_BASE_URL ?? "https://www.anything.com";
const TRACE_DIR = path.resolve(process.cwd(), process.env.TRACE_DIR ?? "data/traces");
const MAX_FAILOVER_ATTEMPTS = Number.parseInt(process.env.MAX_FAILOVER_ATTEMPTS ?? "4", 10);
const API_KEYS = parseApiKeys(process.env.API_KEYS);
const METRICS_TOKEN = process.env.METRICS_TOKEN?.trim() || null;
const USAGE_FILE = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data", "usage-stats.jsonl");
const USAGE_MAX_BYTES = Number.parseInt(process.env.USAGE_MAX_BYTES ?? `${50 * 1024 * 1024}`, 10);
const USAGE_ENABLED = (process.env.ENABLE_USAGE_STATS ?? "true").toLowerCase() !== "false";
interface OpenAIChatCompletionRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
}

interface OpenAICompletionRequest {
  model?: string;
  prompt?: unknown;
  stream?: boolean;
}

interface OpenAIResponsesRequest {
  model?: string;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
}

interface AnthropicMessagesRequest {
  model?: string;
  system?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
}

interface ToolAwareGenerationResult {
  text: string;
  reasoning: string;
  model: string;
  account: PoolAccountRecord;
  toolCall: ParsedToolCall | null;
}

export async function startApiServer(log: (message: string) => void = console.log): Promise<void> {
  if (API_KEYS.length === 0) {
    log("[FATAL] API_KEYS 环境变量未设置；启动被拒。请配置 API_KEYS=key1,key2 后再启动。");
    process.exit(1);
  }
  const backend = new AnythingProxyBackend(log);
  await backend.maybeRotateUsage();
  await backend.refreshPoolMetrics();
  const server = createServer(async (request, response) => {
    const finishMetrics = backend.metrics.beginHttpRequest();
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      finishMetrics();
      return;
    }

    try {
      await routeRequest(backend, request, response);
    } catch (error) {
      log(`[-] 请求处理失败: ${formatError(error)}`);
      sendJson(response, 500, {
        error: {
          message: formatError(error),
          type: "server_error",
        },
      });
    } finally {
      finishMetrics();
    }
  });

  server.listen(PORT, () => {
    log(`[+] 2api 代理已启动: http://127.0.0.1:${PORT}`);
  });
}

class AnythingProxyBackend {
  private readonly pool: AccountPool;
  private readonly browsers = new Map<string, BrowserSessionHandle>();
  private readonly busyAccountIds = new Set<string>();
  public readonly metrics = new MetricsRegistry();
  private readonly usage: UsageTracker | null;

  public constructor(private readonly log: (message: string) => void) {
    this.pool = new AccountPool(log);
    this.usage = USAGE_ENABLED ? new UsageTracker(USAGE_FILE, USAGE_MAX_BYTES) : null;
  }

  public async maybeRotateUsage(): Promise<void> {
    if (this.usage) await this.usage.maybeRotate();
  }

  public async generate(prompt: string, model?: string): Promise<{ text: string; model: string; account: PoolAccountRecord }> {
    const attempted = new Set<string>();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_FAILOVER_ATTEMPTS; attempt += 1) {
      const account = await this.acquireFreeAccount(attempted);
      attempted.add(account.accountId);

      try {
        const result = await this.generateOnce(account, prompt, model);
        await this.pool.markSuccess(account.accountId);
        this.refreshPoolMetrics();
        return result;
      } catch (error) {
        lastError = error;
        this.log(`[-] 账号执行失败: ${account.email} / ${formatError(error)}`);
        await this.pool.markFailure(account.accountId, error);
        this.metrics.recordFailover();
        await this.disposeBrowser(account.accountId);
        this.refreshPoolMetrics();
      } finally {
        this.busyAccountIds.delete(account.accountId);
        this.refreshPoolMetrics();
      }
    }

    throw lastError ?? new Error("没有可用账号可完成请求");
  }

  public async generateStreaming(
    prompt: string,
    model: string | undefined,
    onUpdate: (rawText: string, status: string, model: string, account: PoolAccountRecord) => Promise<void> | void,
  ): Promise<{ text: string; model: string; account: PoolAccountRecord }> {
    const attempted = new Set<string>();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_FAILOVER_ATTEMPTS; attempt += 1) {
      const account = await this.acquireFreeAccount(attempted);
      attempted.add(account.accountId);

      try {
        const result = await this.generateOnce(account, prompt, model, onUpdate);
        await this.pool.markSuccess(account.accountId);
        this.refreshPoolMetrics();
        return result;
      } catch (error) {
        lastError = error;
        this.log(`[-] 账号流式执行失败: ${account.email} / ${formatError(error)}`);
        await this.pool.markFailure(account.accountId, error);
        this.metrics.recordFailover();
        await this.disposeBrowser(account.accountId);
        this.refreshPoolMetrics();
      } finally {
        this.busyAccountIds.delete(account.accountId);
        this.refreshPoolMetrics();
      }
    }

    throw lastError ?? new Error("没有可用账号可完成流式请求");
  }

  private async generateOnce(
    account: PoolAccountRecord,
    prompt: string,
    model?: string,
    onUpdate?: (rawText: string, status: string, model: string, account: PoolAccountRecord) => Promise<void> | void,
  ): Promise<{ text: string; model: string; account: PoolAccountRecord }> {
    const startedAt = Date.now();
    try {
      const browser = await this.ensureBrowser(account);
      const resolvedModel = resolveModel(model);
      const result = await generateProjectGroupRevisionViaGraphql({
        handle: browser,
        targetUrl: account.finalUrl || ANYTHING_BASE_URL,
        projectGroupId: account.projectGroupId,
        prompt,
        preferredModel: resolvedModel.canonical,
        log: this.log,
        onUpdate: async (rawText, status) => {
          await onUpdate?.(rawText, status, resolvedModel.canonical, account);
        },
      });

      await persistTrace({
        session: account,
        prompt,
        model: resolvedModel.canonical,
        result,
      });

      this.metrics.recordGeneration(prompt, result.response.trim());

      const finalText = result.response.trim();
      await this.usage?.record({
        ts: new Date(),
        accountId: account.accountId,
        model: resolvedModel.canonical,
        route: "/v1",
        promptChars: prompt.length,
        completionChars: finalText.length,
        status: "ok",
        latencyMs: Date.now() - startedAt,
      });

      return {
        text: finalText,
        model: resolvedModel.canonical,
        account,
      };
    } catch (error) {
      await this.usage?.record({
        ts: new Date(),
        accountId: account.accountId,
        model: model ?? "unknown",
        route: "/v1",
        promptChars: prompt.length,
        completionChars: 0,
        status: "error",
        errorKind: error instanceof Error ? error.constructor.name : "Unknown",
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async ensureBrowser(account: PoolAccountRecord): Promise<BrowserSessionHandle> {
    const existing = this.browsers.get(account.accountId);
    if (existing) {
      return existing;
    }

    const browser = await openBrowserSession(account.accountDir, account.fingerprint);
    this.browsers.set(account.accountId, browser);
    this.refreshPoolMetrics();
    return browser;
  }

  private async disposeBrowser(accountId: string): Promise<void> {
    const browser = this.browsers.get(accountId);
    if (!browser) {
      return;
    }
    await closeBrowserSession(browser);
    this.browsers.delete(accountId);
    this.refreshPoolMetrics();
  }

  private async acquireFreeAccount(attempted: ReadonlySet<string>): Promise<PoolAccountRecord> {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
      const excluded = new Set<string>([...attempted, ...this.busyAccountIds]);
      try {
        const account = await this.pool.acquireAccount(excluded);
        this.busyAccountIds.add(account.accountId);
        this.refreshPoolMetrics();
        return account;
      } catch {
        await delay(1_000);
      }
    }

    throw new Error("暂无空闲账号");
  }

  public async refreshPoolMetrics(): Promise<void> {
    const summary = await this.pool.getSummary();
    this.metrics.setPoolState({
      active: summary.active,
      cooldown: summary.cooldown,
      deleted: summary.deleted,
      total: summary.total,
      busy: this.busyAccountIds.size,
    });
  }
}

async function routeRequest(
  backend: AnythingProxyBackend,
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    if (METRICS_TOKEN) {
      const token =
        url.searchParams.get("token") ??
        (request.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "") ?? "");
      if (token !== METRICS_TOKEN) {
        sendJson(response, 401, { error: { message: "Unauthorized" } });
        return;
      }
    }
    await backend.refreshPoolMetrics();
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
    response.end(backend.metrics.renderPrometheus());
    return;
  }

  if (url.pathname.startsWith("/admin/")) {
    sendJson(response, 503, { error: { message: "admin console not enabled in this build" } });
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    if (!checkApiKey(request, API_KEYS)) {
      sendJson(response, 401, {
        error: { message: "Invalid or missing API key", type: "authentication_error" },
      });
      return;
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, buildModelsPayload());
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }

  const payload = await readJsonBody(request);

  if (url.pathname === "/v1/chat/completions") {
    const body = payload as OpenAIChatCompletionRequest;
    const basePrompt = buildPromptFromMessages(body.messages ?? []);
    if (body.stream) {
      await streamChatCompletions(response, backend, basePrompt, body.model, body.tools, body.tool_choice);
      return;
    }
    const toolResult = await generateWithOptionalTools({
      backend,
      prompt: basePrompt,
      model: body.model,
      tools: body.tools,
      toolChoice: body.tool_choice,
    });
    if (toolResult.toolCall) {
      backend.metrics.recordToolCall();
    }
    sendJson(response, 200, buildChatCompletionPayload(toolResult));
    return;
  }

  if (url.pathname === "/v1/completions") {
    const body = payload as OpenAICompletionRequest;
    const prompt = normalizeUnknownContent(body.prompt);
    if (body.stream) {
      await streamLegacyCompletion(response, backend, prompt, body.model);
      return;
    }
    const result = await backend.generate(prompt, body.model);
    const cleaned = cleanAssistantOutput(result.text);
    sendJson(response, 200, buildCompletionPayload(cleaned.content, result.model, cleaned.reasoning));
    return;
  }

  if (url.pathname === "/v1/responses") {
    const body = payload as OpenAIResponsesRequest;
    const basePrompt = normalizeResponsesInput(body.input);
    if (body.stream) {
      await streamResponses(response, backend, basePrompt, body.model, body.tools, body.tool_choice);
      return;
    }
    const toolResult = await generateWithOptionalTools({
      backend,
      prompt: basePrompt,
      model: body.model,
      tools: body.tools,
      toolChoice: body.tool_choice,
    });
    if (toolResult.toolCall) {
      backend.metrics.recordToolCall();
    }
    sendJson(response, 200, buildResponsesPayload(toolResult));
    return;
  }

  if (url.pathname === "/v1/messages") {
    const body = payload as AnthropicMessagesRequest;
    const basePrompt = buildAnthropicPrompt(body.system, body.messages ?? []);
    if (body.stream) {
      await streamAnthropicMessages(response, backend, basePrompt, body.model, body.tools, body.tool_choice);
      return;
    }
    const toolResult = await generateWithOptionalTools({
      backend,
      prompt: basePrompt,
      model: body.model,
      tools: body.tools,
      toolChoice: body.tool_choice,
    });
    if (toolResult.toolCall) {
      backend.metrics.recordToolCall();
    }
    sendJson(response, 200, buildAnthropicPayload(toolResult));
    return;
  }

  sendJson(response, 404, { error: { message: "Not found" } });
}

function buildPromptFromMessages(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages
    .map((message) => formatMessageForPrompt(message.role ?? "user", message.content))
    .join("\n\n");
}

function formatMessageForPrompt(role: string, content: unknown): string {
  const normalizedRole = role.toUpperCase();
  return `${normalizedRole}:\n${normalizeUnknownContent(content)}`;
}

function buildAnthropicPrompt(system: unknown, messages: Array<{ role?: string; content?: unknown }>): string {
  const parts: string[] = [];
  const systemText = normalizeUnknownContent(system);
  if (systemText) {
    parts.push(`SYSTEM:\n${systemText}`);
  }
  parts.push(buildPromptFromMessages(messages));
  return parts.join("\n\n");
}

async function generateWithOptionalTools(options: {
  backend: AnythingProxyBackend;
  prompt: string;
  model?: string;
  tools?: unknown;
  toolChoice?: unknown;
}): Promise<ToolAwareGenerationResult> {
  const tools = normalizeTools(options.tools);
  const toolChoice = normalizeToolChoice(options.toolChoice);

  if (tools.length === 0 || toolChoice.mode === "none") {
    const plain = await options.backend.generate(options.prompt, options.model);
    const cleaned = cleanAssistantOutput(plain.text);
    return {
      ...plain,
      text: cleaned.content,
      reasoning: cleaned.reasoning,
      toolCall: null,
    };
  }

  const toolPrompt = buildToolPrompt({
    prompt: options.prompt,
    tools,
    toolChoice: options.toolChoice,
  });
  const generated = await options.backend.generate(toolPrompt, options.model);
  let finalResult = generated;
  let finalized = finalizeToolAwareResult(generated.text, generated.model, generated.account, tools, toolChoice, options.prompt);

  if (toolChoice.mode === "required" && !finalized.toolCall) {
    const retryPrompt = `${toolPrompt}\n\nIMPORTANT: The response is invalid unless it is a JSON tool_call object. Do not answer normally.`;
    const retried = await options.backend.generate(retryPrompt, options.model);
    finalResult = retried;
    finalized = finalizeToolAwareResult(retried.text, retried.model, retried.account, tools, toolChoice, options.prompt);
  }

  return {
    ...finalResult,
    text: finalized.text,
    reasoning: finalized.reasoning,
    toolCall: finalized.toolCall,
  };
}

function finalizeToolAwareResult(
  rawText: string,
  model: string,
  account: PoolAccountRecord,
  tools: ReturnType<typeof normalizeTools>,
  toolChoice: ReturnType<typeof normalizeToolChoice>,
  originalPrompt: string,
): ToolAwareGenerationResult {
  let toolCall = parseToolCallResponse(rawText, tools);
  const cleaned = cleanAssistantOutput(extractFinalContent(rawText));
  let finalText = cleaned.content;
  let reasoning = cleaned.reasoning;

  if (toolChoice.mode === "required" && !toolCall) {
    toolCall = buildHeuristicToolCall(tools, originalPrompt);
  }

  return {
    text: finalText,
    reasoning,
    model,
    account,
    toolCall,
  };
}

function normalizeResponsesInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return normalizeUnknownContent(record.content ?? record.text ?? record.input_text ?? record.message ?? item);
        }

        return String(item);
      })
      .join("\n\n");
  }

  return normalizeUnknownContent(input);
}

function normalizeUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") {
            return record.text;
          }
          if (record.type === "tool_result") {
            return `TOOL_RESULT(${typeof record.tool_use_id === "string" ? record.tool_use_id : "unknown"}): ${normalizeUnknownContent(
              record.content,
            )}`;
          }
          if (record.type === "tool_use") {
            return `TOOL_USE(${typeof record.name === "string" ? record.name : "unknown"}): ${JSON.stringify(
              record.input ?? {},
            )}`;
          }
          return normalizeUnknownContent(record.text ?? record.content ?? JSON.stringify(item));
        }

        return String(item);
      })
      .join("\n");
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    return normalizeUnknownContent(record.text ?? record.content ?? JSON.stringify(content));
  }

  return content == null ? "" : String(content);
}

async function streamChatCompletions(
  response: ServerResponse<IncomingMessage>,
  backend: AnythingProxyBackend,
  prompt: string,
  model: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): Promise<void> {
  setupSse(response);

  const normalizedTools = normalizeTools(tools);
  const normalizedChoice = normalizeToolChoice(toolChoice);
  const toolPrompt =
    normalizedTools.length > 0 && normalizedChoice.mode !== "none"
      ? buildToolPrompt({ prompt, tools: normalizedTools, toolChoice })
      : prompt;

  let emittedText = "";
  let emittedToolName = "";
  let emittedToolArguments = "";
  let activeToolCall: ParsedToolCall | null = null;

  const result = await backend.generateStreaming(toolPrompt, model, async (rawText, _status, activeModel) => {
    if (normalizedTools.length === 0 || normalizedChoice.mode === "none") {
      const cleaned = cleanAssistantOutput(rawText);
      const delta = cleaned.content.slice(emittedText.length);
      emittedText = cleaned.content;
      writeOpenAIChatTextDelta(response, delta, activeModel);
      return;
    }

    const parsed = parseIncrementalOutput(rawText);
    if (parsed.mode !== "tool_call") {
      return;
    }

    activeToolCall ??= {
      id: `call_stream_${Date.now()}`,
      name: parsed.toolName || normalizedTools[0]?.name || "tool",
      argumentsObject: {},
      argumentsText: parsed.toolArguments,
    };

    const toolName = parsed.toolName || activeToolCall.name;
    const nameDelta = toolName.slice(emittedToolName.length);
    const argumentsDelta = parsed.toolArguments.slice(emittedToolArguments.length);
    emittedToolName = toolName;
    emittedToolArguments = parsed.toolArguments;
    activeToolCall.name = toolName;
    activeToolCall.argumentsText = parsed.toolArguments;
    writeOpenAIChatToolCallDelta(response, activeToolCall, nameDelta, argumentsDelta, activeModel);
  });

  if (normalizedTools.length > 0 && normalizedChoice.mode !== "none") {
    const finalized = finalizeToolAwareResult(result.text, result.model, result.account, normalizedTools, normalizedChoice, prompt);
    if (finalized.toolCall) {
      activeToolCall ??= finalized.toolCall;
      const toolName = finalized.toolCall.name;
      const finalArguments = finalized.toolCall.argumentsText;
      writeOpenAIChatToolCallDelta(
        response,
        finalized.toolCall,
        toolName.slice(emittedToolName.length),
        finalArguments.slice(emittedToolArguments.length),
        finalized.model,
      );
      writeOpenAIFinish(response, "tool_calls", finalized.model);
      endSse(response);
      return;
    }

    const contentDelta = finalized.text.slice(emittedText.length);
    emittedText = finalized.text;
    writeOpenAIChatTextDelta(response, contentDelta, finalized.model);
    writeOpenAIFinish(response, "stop", finalized.model);
    endSse(response);
    return;
  }

  writeOpenAIFinish(response, "stop", result.model);
  endSse(response);
}

async function streamLegacyCompletion(
  response: ServerResponse<IncomingMessage>,
  backend: AnythingProxyBackend,
  prompt: string,
  model: string | undefined,
): Promise<void> {
  setupSse(response);
  let emittedText = "";

  const result = await backend.generateStreaming(prompt, model, async (rawText) => {
    const cleaned = cleanAssistantOutput(rawText);
    const delta = cleaned.content.slice(emittedText.length);
    emittedText = cleaned.content;
    if (!delta) {
      return;
    }

    response.write(
      `data: ${JSON.stringify({
        id: `cmpl_${Date.now()}`,
        object: "text_completion",
        model: model ?? "anything-auto",
        choices: [{ text: delta, index: 0, finish_reason: null }],
      })}\n\n`,
    );
  });

  response.write(
    `data: ${JSON.stringify({
      id: `cmpl_${Date.now()}`,
      object: "text_completion",
      model: result.model,
      choices: [{ text: "", index: 0, finish_reason: "stop" }],
    })}\n\n`,
  );
  endSse(response);
}

async function streamResponses(
  response: ServerResponse<IncomingMessage>,
  backend: AnythingProxyBackend,
  prompt: string,
  model: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): Promise<void> {
  setupSse(response);

  const normalizedTools = normalizeTools(tools);
  const normalizedChoice = normalizeToolChoice(toolChoice);
  const toolPrompt =
    normalizedTools.length > 0 && normalizedChoice.mode !== "none"
      ? buildToolPrompt({ prompt, tools: normalizedTools, toolChoice })
      : prompt;

  let emittedText = "";
  let emittedToolName = "";
  let emittedToolArguments = "";
  let activeToolCall: ParsedToolCall | null = null;

  const result = await backend.generateStreaming(toolPrompt, model, async (rawText, _status, activeModel) => {
    if (normalizedTools.length === 0 || normalizedChoice.mode === "none") {
      const cleaned = cleanAssistantOutput(rawText);
      const delta = cleaned.content.slice(emittedText.length);
      emittedText = cleaned.content;
      writeResponsesTextDelta(response, delta, activeModel);
      return;
    }

    const parsed = parseIncrementalOutput(rawText);
    if (parsed.mode !== "tool_call") {
      return;
    }

    activeToolCall ??= {
      id: `call_stream_${Date.now()}`,
      name: parsed.toolName || normalizedTools[0]?.name || "tool",
      argumentsObject: {},
      argumentsText: parsed.toolArguments,
    };

    const toolName = parsed.toolName || activeToolCall.name;
    const nameDelta = toolName.slice(emittedToolName.length);
    const argumentsDelta = parsed.toolArguments.slice(emittedToolArguments.length);
    emittedToolName = toolName;
    emittedToolArguments = parsed.toolArguments;
    activeToolCall.name = toolName;
    activeToolCall.argumentsText = parsed.toolArguments;
    writeResponsesToolCallDelta(response, activeToolCall, nameDelta, argumentsDelta, activeModel);
  });

  if (normalizedTools.length > 0 && normalizedChoice.mode !== "none") {
    const finalized = finalizeToolAwareResult(result.text, result.model, result.account, normalizedTools, normalizedChoice, prompt);
    if (finalized.toolCall) {
      writeResponsesToolCallDelta(
        response,
        finalized.toolCall,
        finalized.toolCall.name.slice(emittedToolName.length),
        finalized.toolCall.argumentsText.slice(emittedToolArguments.length),
        finalized.model,
      );
      response.write(`data: ${JSON.stringify({ type: "response.completed", response: buildResponsesPayload(finalized) })}\n\n`);
      endSse(response);
      return;
    }

    const contentDelta = finalized.text.slice(emittedText.length);
    writeResponsesTextDelta(response, contentDelta, finalized.model);
    response.write(`data: ${JSON.stringify({ type: "response.completed", response: buildResponsesPayload(finalized) })}\n\n`);
    endSse(response);
    return;
  }

  const cleaned = cleanAssistantOutput(result.text);
  response.write(`data: ${JSON.stringify({ type: "response.completed", response: buildResponsesPayload({
    text: cleaned.content,
    reasoning: cleaned.reasoning,
    model: result.model,
    account: result.account,
    toolCall: null,
  }) })}\n\n`);
  endSse(response);
}

async function streamAnthropicMessages(
  response: ServerResponse<IncomingMessage>,
  backend: AnythingProxyBackend,
  prompt: string,
  model: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): Promise<void> {
  setupSse(response);
  writeAnthropicStart(response, model ?? "anything-auto");

  const normalizedTools = normalizeTools(tools);
  const normalizedChoice = normalizeToolChoice(toolChoice);
  const toolPrompt =
    normalizedTools.length > 0 && normalizedChoice.mode !== "none"
      ? buildToolPrompt({ prompt, tools: normalizedTools, toolChoice })
      : prompt;

  let emittedText = "";
  let emittedToolName = "";
  let emittedToolArguments = "";
  let activeToolCall: ParsedToolCall | null = null;

  const result = await backend.generateStreaming(toolPrompt, model, async (rawText) => {
    if (normalizedTools.length === 0 || normalizedChoice.mode === "none") {
      const cleaned = cleanAssistantOutput(rawText);
      const delta = cleaned.content.slice(emittedText.length);
      emittedText = cleaned.content;
      writeAnthropicTextDelta(response, delta);
      return;
    }

    const parsed = parseIncrementalOutput(rawText);
    if (parsed.mode !== "tool_call") {
      return;
    }

    activeToolCall ??= {
      id: `toolu_${Date.now()}`,
      name: parsed.toolName || normalizedTools[0]?.name || "tool",
      argumentsObject: {},
      argumentsText: parsed.toolArguments,
    };

    const toolName = parsed.toolName || activeToolCall.name;
    writeAnthropicToolDelta(
      response,
      activeToolCall,
      toolName.slice(emittedToolName.length),
      parsed.toolArguments.slice(emittedToolArguments.length),
    );
    emittedToolName = toolName;
    emittedToolArguments = parsed.toolArguments;
    activeToolCall.name = toolName;
    activeToolCall.argumentsText = parsed.toolArguments;
  });

  if (normalizedTools.length > 0 && normalizedChoice.mode !== "none") {
    const finalized = finalizeToolAwareResult(result.text, result.model, result.account, normalizedTools, normalizedChoice, prompt);
    if (finalized.toolCall) {
      writeAnthropicToolDelta(
        response,
        finalized.toolCall,
        finalized.toolCall.name.slice(emittedToolName.length),
        finalized.toolCall.argumentsText.slice(emittedToolArguments.length),
      );
      writeAnthropicStop(response, "tool_use");
      response.end();
      return;
    }

    writeAnthropicTextDelta(response, finalized.text.slice(emittedText.length));
    writeAnthropicStop(response, "end_turn");
    response.end();
    return;
  }

  writeAnthropicStop(response, "end_turn");
  response.end();
}

function buildHeuristicToolCall(
  tools: ReturnType<typeof normalizeTools>,
  prompt: string,
): ParsedToolCall | null {
  if (tools.length === 0) {
    return null;
  }

  const tool = tools[0]!;
  const properties = asRecord(tool.inputSchema.properties);
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((item): item is string => typeof item === "string")
    : [];
  const keys = Array.from(new Set([...Object.keys(properties), ...required]));
  const argumentsObject: Record<string, unknown> = {};

  for (const key of keys) {
    const schema = asRecord(properties[key]);
    argumentsObject[key] = inferToolArgumentValue(key, schema, prompt);
  }

  return {
    id: `call_fallback_${Date.now()}`,
    name: tool.name,
    argumentsObject,
    argumentsText: JSON.stringify(argumentsObject),
  };
}

function inferToolArgumentValue(key: string, schema: Record<string, unknown>, prompt: string): unknown {
  const lowerKey = key.toLowerCase();
  const schemaType = typeof schema.type === "string" ? schema.type : "string";

  if (schemaType === "boolean") {
    return false;
  }

  if (schemaType === "number" || schemaType === "integer") {
    return 0;
  }

  if (schemaType === "array") {
    return [];
  }

  if (schemaType === "object") {
    return {};
  }

  if (/(city|location|place|query|q|keyword)/i.test(lowerKey)) {
    return extractLikelyLocation(prompt) ?? prompt;
  }

  return prompt;
}

function extractLikelyLocation(prompt: string): string | null {
  const chineseCityMatch = prompt.match(/([\p{Script=Han}]{2,}(?:市|省|区|县)?)/u);
  if (chineseCityMatch?.[1]) {
    return chineseCityMatch[1];
  }

  const asciiMatch = prompt.match(/\b([A-Za-z][A-Za-z\s-]{1,40})\b/);
  return asciiMatch?.[1]?.trim() ?? null;
}

function buildModelsPayload(): unknown {
  return {
    object: "list",
    data: SUPPORTED_MODEL_IDS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "anything-browser-proxy",
    })),
  };
}

function buildChatCompletionPayload(result: ToolAwareGenerationResult): unknown {
  const created = Math.floor(Date.now() / 1_000);
  return {
    id: `chatcmpl_${created}`,
    object: "chat.completion",
    created,
    model: result.model,
    choices: [
      result.toolCall
        ? {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: result.toolCall.id,
                  type: "function",
                  function: {
                    name: result.toolCall.name,
                    arguments: result.toolCall.argumentsText,
                  },
                },
              ],
            },
          }
        : {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: result.text,
              reasoning: result.reasoning || undefined,
            },
          },
    ],
    reasoning: result.reasoning || undefined,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildCompletionPayload(text: string, model: string, reasoning = ""): unknown {
  const created = Math.floor(Date.now() / 1_000);
  return {
    id: `cmpl_${created}`,
    object: "text_completion",
    created,
    model,
    choices: [
      {
        text,
        index: 0,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    reasoning: reasoning || undefined,
  };
}

function buildResponsesPayload(result: ToolAwareGenerationResult): unknown {
  const created = Math.floor(Date.now() / 1_000);
  return {
    id: `resp_${created}`,
    object: "response",
    created_at: created,
    model: result.model,
    output: result.toolCall
      ? [
          {
            type: "function_call",
            id: `fc_${created}`,
            call_id: result.toolCall.id,
            name: result.toolCall.name,
            arguments: result.toolCall.argumentsText,
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: result.text,
              },
            ],
          },
        ],
    output_text: result.toolCall ? "" : result.text,
    status: "completed",
    reasoning: result.reasoning || undefined,
  };
}

function buildAnthropicPayload(result: ToolAwareGenerationResult): unknown {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: result.model,
    stop_reason: result.toolCall ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
    reasoning: result.reasoning || undefined,
    content: result.toolCall
      ? [
          {
            type: "tool_use",
            id: result.toolCall.id,
            name: result.toolCall.name,
            input: result.toolCall.argumentsObject,
          },
        ]
      : [
          {
            type: "text",
            text: result.text,
          },
        ],
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function setCorsHeaders(response: ServerResponse<IncomingMessage>): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-api-key, anthropic-version");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

async function persistTrace(payload: {
  session: AccountSessionRecord;
  prompt: string;
  model: string;
  result: Awaited<ReturnType<typeof generateProjectGroupRevisionViaGraphql>>;
}): Promise<void> {
  await mkdir(TRACE_DIR, { recursive: true });
  const fileName = `${Date.now()}-${payload.session.accountId}.json`;
  await writeFile(path.join(TRACE_DIR, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
