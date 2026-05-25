import { mkdir } from "node:fs/promises";
import path from "node:path";

import puppeteerExtraModule from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

import { resolveModel } from "./model-catalog.js";
import type { StableFingerprint } from "./fingerprint.js";
import { formatError } from "./util/error.js";

const puppeteerExtra = puppeteerExtraModule as unknown as {
  use(plugin: unknown): void;
  launch(options: unknown): Promise<Browser>;
};
puppeteerExtra.use(StealthPlugin());

const ANYTHING_BASE_URL = process.env.ANYTHING_BASE_URL ?? "https://www.anything.com";
const HEADLESS_MODE = (process.env.HEADLESS ?? "true").toLowerCase();

export interface LoginLaunchOptions {
  accountDir: string;
  fingerprint: StableFingerprint;
  magicLink: string;
  log?: (message: string) => void;
}

export interface PromptRunResult {
  text: string;
  pageUrl: string;
  requests: Array<{
    url: string;
    method: string;
    resourceType: string;
    postData?: string;
  }>;
  responses: Array<{
    url: string;
    status: number;
    bodyPreview: string;
    contentType: string;
  }>;
  domSnapshot: string;
}

export interface BrowserSessionHandle {
  browser: Browser;
  accountDir: string;
  fingerprint: StableFingerprint;
}

export interface GraphqlGenerationResult {
  revisionId: string;
  status: string;
  response: string;
}

export async function launchAndLoginWithMagicLink(options: LoginLaunchOptions): Promise<{ finalUrl: string; title: string }> {
  const browser = await launchBrowser({
    accountDir: options.accountDir,
    fingerprint: options.fingerprint,
  });

  try {
    const page = await browser.newPage();
    await preparePage(page, options.fingerprint);
    await page.goto(normalizeMagicLinkForBrowser(options.magicLink), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForNonTrackingUrl(page, 60_000);
    await waitForSettledPage(page);

    const finalUrl = page.url();
    const title = await page.title();
    options.log?.(`[+] 浏览器登录完成: ${finalUrl}`);

    return {
      finalUrl,
      title,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function openBrowserSession(
  accountDir: string,
  fingerprint: StableFingerprint,
  options: { headless?: boolean; display?: string } = {},
): Promise<BrowserSessionHandle> {
  const browser = await launchBrowser({
    accountDir,
    fingerprint,
    headless: options.headless,
    display: options.display,
  });
  return {
    browser,
    accountDir,
    fingerprint,
  };
}

export async function closeBrowserSession(handle: BrowserSessionHandle): Promise<void> {
  await handle.browser.close().catch(() => undefined);
}

export async function runPromptInBrowser(
  handle: BrowserSessionHandle,
  targetUrl: string,
  prompt: string,
  log: (message: string) => void = console.log,
): Promise<PromptRunResult> {
  const page = await handle.browser.newPage();
  await preparePage(page, handle.fingerprint);

  const capturedRequests: PromptRunResult["requests"] = [];
  const capturedResponses: PromptRunResult["responses"] = [];
  const promptSnippet = prompt.slice(0, 120);
  const trackedRequests = new WeakSet<object>();

  page.on("request", (request) => {
    const postData = request.postData() ?? undefined;
    const isInteresting =
      request.resourceType() === "fetch" ||
      request.resourceType() === "xhr" ||
      request.resourceType() === "document";

    if (!isInteresting) {
      return;
    }

    if (postData?.includes(promptSnippet) || request.url().includes("/api/") || request.url().includes("graphql")) {
      trackedRequests.add(request);
      capturedRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData: truncate(postData, 1_000),
      });
    }
  });

  page.on("response", async (response) => {
    const request = response.request();
    const contentType = response.headers()["content-type"] ?? "";
    const maybeInteresting =
      trackedRequests.has(request) ||
      response.url().includes("/api/") ||
      response.url().includes("graphql") ||
      contentType.includes("json") ||
      contentType.includes("event-stream");

    if (!maybeInteresting) {
      return;
    }

    try {
      const body = await response.text();
      capturedResponses.push({
        url: response.url(),
        status: response.status(),
        bodyPreview: truncate(body, 2_000) ?? "",
        contentType,
      });
    } catch (error) {
      capturedResponses.push({
        url: response.url(),
        status: response.status(),
        bodyPreview: `[unreadable] ${formatError(error)}`,
        contentType,
      });
    }
  });

  try {
    await page.goto(targetUrl || ANYTHING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForSettledPage(page);

    const inputSelector = await locatePromptInput(page);
    if (!inputSelector) {
      const domSnapshot = await snapshotText(page);
      throw new Error(`未找到可用输入框。页面快照:\n${domSnapshot}`);
    }

    await fillPrompt(page, inputSelector, prompt);
    await submitPrompt(page, inputSelector);
    await delay(6_000);

    const domSnapshot = await snapshotText(page);
    const extracted = extractBestText(capturedResponses) ?? domSnapshot;

    log(`[+] Prompt 执行完成，抓到 ${capturedRequests.length} 个请求 / ${capturedResponses.length} 个响应`);

    return {
      text: extracted,
      pageUrl: page.url(),
      requests: capturedRequests,
      responses: capturedResponses,
      domSnapshot,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function generateProjectGroupRevisionViaGraphql(options: {
  handle: BrowserSessionHandle;
  targetUrl: string;
  projectGroupId: string;
  prompt: string;
  preferredModel?: string;
  log?: (message: string) => void;
  onUpdate?: (rawText: string, status: string) => Promise<void> | void;
}): Promise<GraphqlGenerationResult> {
  const page = await options.handle.browser.newPage();
  await preparePage(page, options.handle.fingerprint);
  const resolvedModel = resolveModel(options.preferredModel);

  try {
    await page.goto(options.targetUrl || ANYTHING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForSettledPage(page);

    const generateResult = await graphqlRequest(page, {
      operationName: "GenerateProjectGroupRevisionFromChat",
      variables: {
        input: {
          projectGroupId: options.projectGroupId,
          content: wrapPromptForModel(options.prompt, resolvedModel),
          viewingModuleId: null,
          action: "AUTO_SELECT_CHAT",
          useExtendedThinking: true,
          preferredGenerationProvider: resolvedModel.preferredGenerationProvider,
          threadId: null,
        },
      },
      extensions: {
        clientLibrary: {
          name: "@apollo/client",
          version: "4.1.6",
        },
      },
      query: `
mutation GenerateProjectGroupRevisionFromChat($input: GenerateProjectGroupRevisionFromChatInput!) {
  generateProjectGroupRevisionFromChat(input: $input) {
    success
    projectGroupRevision {
      id
      response
      status
      createdAt
      chat {
        id
        content
        __typename
      }
      __typename
    }
    askForUserProfileInfo
    errors {
      kind
      message
      __typename
    }
    __typename
  }
}
      `.trim(),
    });

    const generatePayload = asRecord(generateResult.data)?.generateProjectGroupRevisionFromChat;
    const generation = asRecord(generatePayload);
    const revision = asRecord(generation.projectGroupRevision);
    const revisionId = asString(revision.id);
    const status = asString(revision.status);
    const immediateResponse = asString(revision.response);
    const errors = generation.errors;

    if (!revisionId) {
      throw new Error(`生成请求未返回 revision id: ${JSON.stringify(errors ?? generation, null, 2)}`);
    }

    if (immediateResponse.trim()) {
      await options.onUpdate?.(immediateResponse, status || "COMPLETED");
      return {
        revisionId,
        status: status || "COMPLETED",
        response: immediateResponse,
      };
    }

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await delay(2_000);
      const pollResult = await graphqlRequest(page, {
        operationName: "GetLatestRevisionForProxy",
        variables: {
          projectGroupId: options.projectGroupId,
        },
        extensions: {
          clientLibrary: {
            name: "@apollo/client",
            version: "4.1.6",
          },
        },
        query: `
query GetLatestRevisionForProxy($projectGroupId: ID!) {
  projectGroupById(id: $projectGroupId) {
    id
    latestRevision {
      id
      response
      status
      createdAt
      chat {
        id
        content
        __typename
      }
      __typename
    }
    __typename
  }
}
        `.trim(),
      });

      const latestRevision = asRecord(asRecord(asRecord(pollResult.data).projectGroupById).latestRevision);
      const latestRevisionId = asString(latestRevision.id);
      const latestStatus = asString(latestRevision.status);
      const latestResponse = asString(latestRevision.response);

      options.log?.(`[*] 轮询 revision ${attempt}/60: id=${latestRevisionId}, status=${latestStatus}`);

      if (latestRevisionId !== revisionId) {
        continue;
      }

      if (latestResponse.trim()) {
        await options.onUpdate?.(latestResponse, latestStatus);
      }

      if (latestResponse.trim()) {
        return {
          revisionId,
          status: latestStatus || "COMPLETED",
          response: latestResponse,
        };
      }

      if (["FAILED", "ERROR", "CANCELLED"].includes(latestStatus)) {
        throw new Error(`生成失败: revision=${revisionId}, status=${latestStatus}`);
      }
    }

    throw new Error(`等待生成结果超时: revision=${revisionId}, status=${status}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export interface InteractiveLoginResult {
  finalUrl: string;
  title: string;
  userId: string;
  email: string;
  projectGroupId: string;
}

export async function runInteractiveLogin(options: {
  handle: BrowserSessionHandle;
  log?: (message: string) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<InteractiveLoginResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const page = await options.handle.browser.newPage();
  await preparePage(page, options.handle.fingerprint);
  await page.goto(`${ANYTHING_BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("登录已被取消");
      await delay(pollMs);

      const url = page.url();
      if (!url.startsWith(ANYTHING_BASE_URL)) continue;
      if (url.match(/\/(login|signup|auth)(\/|$|\?)/i)) continue;

      const cookies = await page.cookies();
      if (!cookies.find((c) => c.name === "lS_authToken" && c.value)) continue;

      try {
        const meResponse = await graphqlRequest(page, {
          operationName: "Me",
          variables: {},
          extensions: { clientLibrary: { name: "@apollo/client", version: "4.1.6" } },
          query: `query Me { me { id email displayName __typename } }`,
        });
        const me = (meResponse as { data?: { me?: { id?: string; email?: string } } }).data?.me;
        if (!me?.id || !me.email) continue;

        const groupResponse = await graphqlRequest(page, {
          operationName: "GetProjectGroups",
          variables: {
            organizationId: null,
            input: { organizationId: null, orderBy: { field: "UPDATED_AT", direction: "DESC" } },
          },
          extensions: { clientLibrary: { name: "@apollo/client", version: "4.1.6" } },
          query: `query GetProjectGroups($organizationId: ID, $input: ProjectGroupsInput!) {
            projectGroups(input: $input) { edges { node { id name __typename } __typename } __typename }
          }`,
        });
        const edges =
          (groupResponse as { data?: { projectGroups?: { edges?: Array<{ node?: { id?: string } }> } } })
            .data?.projectGroups?.edges ?? [];
        const projectGroupId = edges[0]?.node?.id;
        if (!projectGroupId) {
          log("[!] 当前账号还没有任何项目，请到 anything.com 主页新建一个项目后回到本页继续。");
          continue;
        }

        return {
          finalUrl: url,
          title: await page.title(),
          userId: me.id,
          email: me.email,
          projectGroupId,
        };
      } catch (error) {
        log(`[!] 登录校验失败，继续等待: ${formatError(error)}`);
      }
    }

    throw new Error("登录超时");
  } finally {
    await page.close().catch(() => undefined);
  }
}

interface LaunchOptions {
  accountDir: string;
  fingerprint: StableFingerprint;
  headless?: boolean;
  display?: string;
}

async function launchBrowser(options: LaunchOptions): Promise<Browser> {
  await mkdir(path.join(options.accountDir, "user-data"), { recursive: true });

  const headless = options.headless ?? (HEADLESS_MODE !== "false");

  const prevDisplay = process.env.DISPLAY;
  if (options.display) process.env.DISPLAY = options.display;
  try {
    return await puppeteerExtra.launch({
      headless,
      ignoreDefaultArgs: ["--enable-automation"],
      ignoreHTTPSErrors: true,
      userDataDir: path.join(options.accountDir, "user-data"),
      defaultViewport: null,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--ignore-certificate-errors",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,OptimizationHints,MediaRouter",
        `--window-size=${options.fingerprint.viewport.width},${options.fingerprint.viewport.height}`,
      ],
    });
  } finally {
    if (options.display) {
      if (prevDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prevDisplay;
    }
  }
}

async function preparePage(page: Page, fingerprint: StableFingerprint): Promise<void> {
  await page.setUserAgent(fingerprint.userAgent);
  await page.setViewport(fingerprint.viewport);
  await page.setExtraHTTPHeaders({
    "accept-language": fingerprint.acceptLanguage,
  });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: fingerprint.colorScheme }]);
  await page.evaluateOnNewDocument(applyFingerprint, fingerprint);
}

async function waitForNonTrackingUrl(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (url && !url.includes("/ls/click")) {
      return;
    }
    await delay(500);
  }
  throw new Error("Magic Link 打开后长时间停留在跟踪跳转页");
}

async function waitForSettledPage(page: Page): Promise<void> {
  await Promise.all([
    page.waitForNetworkIdle({ idleTime: 1_000, timeout: 10_000 }).catch(() => undefined),
    delay(2_000),
  ]);
}

async function locatePromptInput(page: Page): Promise<string | null> {
  const selectors = [
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']",
  ];

  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) {
      await handle.dispose();
      return selector;
    }
  }

  return null;
}

async function fillPrompt(page: Page, selector: string, prompt: string): Promise<void> {
  const element = await page.waitForSelector(selector, {
    timeout: 20_000,
    visible: true,
  });

  if (!element) {
    throw new Error(`未找到输入框: ${selector}`);
  }

  await element.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");

  if (selector === "textarea") {
    await page.type(selector, prompt, { delay: 10 });
    return;
  }

  await page.evaluate(
    ({ value, currentSelector }) => {
      const node = document.querySelector(currentSelector);
      if (!node) {
        return;
      }

      node.textContent = value;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    },
    { value: prompt, currentSelector: selector },
  );
}

async function submitPrompt(page: Page, selector: string): Promise<void> {
  const submitSelectors = [
    "button[type='submit']",
    "form button",
    "button[aria-label*='Send']",
    "button[title*='Send']",
  ];

  for (const submitSelector of submitSelectors) {
    const button = await page.$(submitSelector);
    if (!button) {
      continue;
    }

    const disabled = await button.evaluate((node) => {
      const element = node as HTMLButtonElement;
      return element.disabled || element.getAttribute("aria-disabled") === "true";
    });

    if (disabled) {
      await button.dispose();
      continue;
    }

    await button.click();
    await button.dispose();
    return;
  }

  await page.focus(selector);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("Enter");
  await page.keyboard.up(modifier);
}

async function snapshotText(page: Page): Promise<string> {
  const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
  return truncate(bodyText.replace(/\n{3,}/g, "\n\n").trim(), 4_000) ?? "";
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return value;
  }

  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

function extractBestText(responses: PromptRunResult["responses"]): string | null {
  for (const response of responses) {
    const extracted = extractTextFromPayload(response.bodyPreview);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

async function graphqlRequest(
  page: Page,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const probe = await page.evaluate(async (requestPayload) => {
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/graphql-response+json,application/json;q=0.9",
        "content-type": "application/json",
        "apollographql-client-name": "flux-web",
      },
      body: JSON.stringify(requestPayload),
    });
    const text = await response.text();
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      text,
    };
  }, payload);

  if (probe.status < 200 || probe.status >= 300) {
    const err = new Error(
      `GraphQL HTTP ${probe.status}: ${truncate(probe.text, 300) ?? ""}`,
    ) as Error & { status?: number; retryAfter?: string | null };
    err.status = probe.status;
    err.retryAfter = probe.retryAfter;
    throw err;
  }

  try {
    return JSON.parse(probe.text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`GraphQL 返回了无效 JSON: ${formatError(error)} / ${truncate(probe.text, 500)}`);
  }
}

function extractTextFromPayload(raw: string): string | null {
  const asJson = tryParseJson(raw);
  if (asJson) {
    const text = findInterestingText(asJson);
    if (text) {
      return text;
    }
  }

  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of dataLines) {
    const parsed = tryParseJson(line);
    if (!parsed) {
      continue;
    }

    const text = findInterestingText(parsed);
    if (text) {
      return text;
    }
  }

  return null;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findInterestingText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 20 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return trimmed;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findInterestingText(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ["output_text", "text", "content", "message", "completion", "response"];

  for (const key of preferredKeys) {
    const nested = findInterestingText(record[key]);
    if (nested) {
      return nested;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findInterestingText(nestedValue);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function wrapPromptForModel(
  prompt: string,
  resolvedModel: ReturnType<typeof resolveModel>,
): string {
  if (!resolvedModel.canonical || resolvedModel.canonical === "anything-auto") {
    return prompt;
  }

  return `[Requested model: ${resolvedModel.canonical}]\n\n${prompt}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeMagicLinkForBrowser(magicLink: string): string {
  if (!magicLink.startsWith("http://url")) {
    return magicLink;
  }

  return magicLink.replace(/^http:\/\//i, "https://");
}

function applyFingerprint(fingerprint: StableFingerprint): void {
  const defineValue = <T>(target: object, key: string, value: T) => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
    });
  };

  try {
    delete (Navigator.prototype as unknown as Record<string, unknown>).webdriver;
  } catch {
    // ignore
  }

  defineValue(navigator, "webdriver", undefined);
  defineValue(navigator, "platform", fingerprint.platform);
  defineValue(navigator, "language", fingerprint.locale);
  defineValue(navigator, "languages", fingerprint.acceptLanguage.split(",").map((item) => item.split(";")[0] ?? item));
  defineValue(navigator, "hardwareConcurrency", fingerprint.hardwareConcurrency);
  defineValue(navigator, "deviceMemory", fingerprint.deviceMemory);
  defineValue(navigator, "maxTouchPoints", fingerprint.maxTouchPoints);

  const patchWebGl = (prototype: WebGLRenderingContext | WebGL2RenderingContext) => {
    const original = prototype.getParameter;
    prototype.getParameter = function patchedGetParameter(parameter: number): unknown {
      if (parameter === 37445) {
        return fingerprint.webglVendor;
      }
      if (parameter === 37446) {
        return fingerprint.webglRenderer;
      }
      return original.call(this, parameter);
    };
  };

  patchWebGl(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") {
    patchWebGl(WebGL2RenderingContext.prototype);
  }
}
