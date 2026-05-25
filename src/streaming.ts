import type { ServerResponse } from "node:http";

import type { ParsedToolCall } from "./tool-calls.js";

export interface ParsedIncrementalOutput {
  mode: "text" | "final" | "tool_call";
  text: string;
  toolName: string | null;
  toolArguments: string;
}

export function parseIncrementalOutput(raw: string): ParsedIncrementalOutput {
  const jsonStart = findStructuredStart(raw);
  if (jsonStart < 0) {
    return {
      mode: "text",
      text: raw,
      toolName: null,
      toolArguments: "",
    };
  }

  const structured = raw.slice(jsonStart);
  const type = extractFieldValue(structured, "type");

  if (type?.startsWith("tool_call")) {
    return {
      mode: "tool_call",
      text: "",
      toolName: extractFieldValue(structured, "name"),
      toolArguments: extractArgumentsPayload(structured),
    };
  }

  if (type?.startsWith("final")) {
    return {
      mode: "final",
      text: extractFieldValue(structured, "content"),
      toolName: null,
      toolArguments: "",
    };
  }

  return {
    mode: "text",
    text: raw.slice(0, jsonStart),
    toolName: null,
    toolArguments: "",
  };
}

export function setupSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write(":\n\n");
}

export function endSse(response: ServerResponse): void {
  response.write("data: [DONE]\n\n");
  response.end();
}

export function writeOpenAIChatTextDelta(response: ServerResponse, content: string, model: string): void {
  if (!content) {
    return;
  }

  for (const chunk of splitText(content, 120)) {
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl_${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1_000),
        model,
        choices: [
          {
            index: 0,
            delta: {
              content: chunk,
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
  }
}

export function writeOpenAIChatToolCallDelta(
  response: ServerResponse,
  toolCall: ParsedToolCall,
  nameDelta: string,
  argumentsDelta: string,
  model: string,
): void {
  if (!nameDelta && !argumentsDelta) {
    return;
  }

  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: {
                  name: nameDelta || undefined,
                  arguments: argumentsDelta || undefined,
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

export function writeOpenAIFinish(response: ServerResponse, finishReason: "stop" | "tool_calls", model: string): void {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl_${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason,
        },
      ],
    })}\n\n`,
  );
}

export function writeResponsesTextDelta(response: ServerResponse, content: string, model: string): void {
  if (!content) {
    return;
  }

  for (const chunk of splitText(content, 120)) {
    response.write(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: chunk,
        model,
      })}\n\n`,
    );
  }
}

export function writeResponsesToolCallDelta(
  response: ServerResponse,
  toolCall: ParsedToolCall,
  nameDelta: string,
  argumentsDelta: string,
  model: string,
): void {
  if (nameDelta) {
    response.write(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        item: {
          type: "function_call",
          call_id: toolCall.id,
          name: nameDelta,
          arguments: "",
        },
        model,
      })}\n\n`,
    );
  }

  if (argumentsDelta) {
    response.write(
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        call_id: toolCall.id,
        delta: argumentsDelta,
        model,
      })}\n\n`,
    );
  }
}

export function writeAnthropicTextDelta(response: ServerResponse, content: string): void {
  if (!content) {
    return;
  }

  for (const chunk of splitText(content, 120)) {
    response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: chunk }, index: 0 })}\n\n`);
  }
}

export function writeAnthropicToolDelta(
  response: ServerResponse,
  toolCall: ParsedToolCall,
  nameDelta: string,
  argumentsDelta: string,
): void {
  if (nameDelta) {
    response.write(
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolCall.id,
          name: nameDelta,
          input: {},
        },
      })}\n\n`,
    );
  }

  if (argumentsDelta) {
    response.write(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: argumentsDelta,
        },
      })}\n\n`,
    );
  }
}

export function writeAnthropicStart(response: ServerResponse, model: string): void {
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model } })}\n\n`);
}

export function writeAnthropicStop(response: ServerResponse, stopReason: "end_turn" | "tool_use"): void {
  response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
  response.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
}

function findStructuredStart(raw: string): number {
  const candidates = raw.matchAll(/\{/g);
  for (const candidate of candidates) {
    const index = candidate.index ?? -1;
    const preview = raw.slice(index, index + 120);
    if (/"type"\s*:\s*"/i.test(preview)) {
      return index;
    }
  }
  return -1;
}

function extractFieldValue(source: string, field: string): string {
  const keyPattern = new RegExp(`"${field}"\\s*:\\s*"`, "i");
  const match = keyPattern.exec(source);
  if (!match) {
    return "";
  }

  const start = (match.index ?? 0) + match[0].length;
  let value = "";
  let escaping = false;

  for (let index = start; index < source.length; index += 1) {
    const current = source[index] ?? "";
    if (escaping) {
      value += decodeEscape(current);
      escaping = false;
      continue;
    }

    if (current === "\\") {
      escaping = true;
      continue;
    }

    if (current === '"') {
      break;
    }

    value += current;
  }

  return value;
}

function extractArgumentsPayload(source: string): string {
  const objectMatch = source.match(/"arguments"\s*:\s*(\{[\s\S]*)/i);
  if (objectMatch?.[1]) {
    return objectMatch[1].trim();
  }

  return extractFieldValue(source, "arguments");
}

function decodeEscape(value: string): string {
  switch (value) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case '"':
      return '"';
    case "\\":
      return "\\";
    default:
      return value;
  }
}

function splitText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}
