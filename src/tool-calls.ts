import { randomUUID } from "node:crypto";

export interface NormalizedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  argumentsObject: Record<string, unknown>;
  argumentsText: string;
}

export interface ToolPromptOptions {
  prompt: string;
  tools: NormalizedToolDefinition[];
  toolChoice?: unknown;
}

export function normalizeTools(input: unknown): NormalizedToolDefinition[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      if (record.type === "function" && record.function && typeof record.function === "object") {
        const fn = record.function as Record<string, unknown>;
        const name = typeof fn.name === "string" ? fn.name : "";
        if (!name) {
          return null;
        }
        return {
          name,
          description: typeof fn.description === "string" ? fn.description : "",
          inputSchema: asRecord(fn.parameters),
        };
      }

      const name = typeof record.name === "string" ? record.name : "";
      if (!name) {
        return null;
      }

      return {
        name,
        description: typeof record.description === "string" ? record.description : "",
        inputSchema: asRecord(record.input_schema ?? record.parameters),
      };
    })
    .filter((item): item is NormalizedToolDefinition => item !== null);
}

export function buildToolPrompt(options: ToolPromptOptions): string {
  const choice = normalizeToolChoice(options.toolChoice);
  const toolSummary = options.tools
    .map((tool) =>
      [
        `Tool: ${tool.name}`,
        tool.description ? `Description: ${tool.description}` : "",
        `Input schema: ${JSON.stringify(tool.inputSchema)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  const toolChoiceInstruction =
    choice.mode === "none"
      ? "Do not call any tool. Return a final answer."
      : choice.mode === "required"
        ? `You must call exactly one tool${choice.name ? ` named "${choice.name}"` : ""}.`
        : choice.mode === "auto"
          ? "Call a tool only if it is necessary. Otherwise return a final answer."
          : "Return a final answer.";

  return [
    "You are operating behind a compatibility proxy.",
    toolChoiceInstruction,
    "Return JSON only, with no markdown fences.",
    "If you choose a tool, return:",
    '{"type":"tool_call","name":"tool_name","arguments":{"example":"value"}}',
    "If you choose not to call a tool, return:",
    '{"type":"final","content":"your answer"}',
    "",
    "Available tools:",
    toolSummary,
    "",
    "User request:",
    options.prompt,
  ].join("\n");
}

export function parseToolCallResponse(rawText: string, tools: NormalizedToolDefinition[]): ParsedToolCall | null {
  const parsed = extractJsonObject(rawText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.type !== "tool_call") {
    return null;
  }

  const name = typeof record.name === "string" ? record.name : "";
  if (!name || !tools.some((tool) => tool.name === name)) {
    return null;
  }

  const argumentsObject = asRecord(record.arguments);
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    name,
    argumentsObject,
    argumentsText: JSON.stringify(argumentsObject),
  };
}

export function extractFinalContent(rawText: string): string {
  const parsed = extractJsonObject(rawText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rawText.trim();
  }

  const record = parsed as Record<string, unknown>;
  if (record.type === "final" && typeof record.content === "string") {
    return record.content.trim();
  }

  return rawText.trim();
}

export function normalizeToolChoice(toolChoice: unknown): { mode: "none" | "auto" | "required"; name: string | null } {
  if (toolChoice == null) {
    return { mode: "auto", name: null };
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "none") {
      return { mode: "none", name: null };
    }
    if (toolChoice === "required") {
      return { mode: "required", name: null };
    }
    return { mode: "auto", name: null };
  }

  if (typeof toolChoice === "object") {
    const record = toolChoice as Record<string, unknown>;
    if (record.type === "function" && record.function && typeof record.function === "object") {
      const fn = record.function as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : null;
      return { mode: "required", name };
    }
    if (record.type === "tool" && typeof record.name === "string") {
      return { mode: "required", name: record.name };
    }
  }

  return { mode: "auto", name: null };
}

function extractJsonObject(rawText: string): unknown | null {
  const trimmed = rawText.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return direct;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = tryParseJson(fenceMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  const candidates = collectJsonObjectCandidates(trimmed);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseJson(candidates[index] ?? "");
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function collectJsonObjectCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let inString = false;
  let escaping = false;
  let startIndex = -1;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? "";

    if (escaping) {
      escaping = false;
      continue;
    }

    if (current === "\\") {
      escaping = true;
      continue;
    }

    if (current === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (current === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (current === "}") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        candidates.push(input.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return candidates;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
