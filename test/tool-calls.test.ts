import assert from "node:assert/strict";
import test from "node:test";

import {
  buildToolPrompt,
  extractFinalContent,
  normalizeToolChoice,
  normalizeTools,
  parseToolCallResponse,
} from "../src/tool-calls.js";

test("normalizeTools supports OpenAI and Anthropic formats", () => {
  const tools = normalizeTools([
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    },
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]);

  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, "search_web");
  assert.equal(tools[1]?.name, "get_weather");
});

test("buildToolPrompt includes tool instructions and schema", () => {
  const prompt = buildToolPrompt({
    prompt: "查一下天气",
    tools: [
      {
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    toolChoice: "required",
  });

  assert.match(prompt, /You must call exactly one tool/i);
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /Input schema/);
});

test("parseToolCallResponse extracts tool call json", () => {
  const tools = normalizeTools([
    {
      type: "function",
      function: {
        name: "search_web",
        parameters: { type: "object" },
      },
    },
  ]);

  const toolCall = parseToolCallResponse(
    '```json\n{"type":"tool_call","name":"search_web","arguments":{"q":"openai"}}\n```',
    tools,
  );

  assert.ok(toolCall);
  assert.equal(toolCall?.name, "search_web");
  assert.equal(toolCall?.argumentsObject.q, "openai");
});

test("extractFinalContent prefers final json wrapper", () => {
  const content = extractFinalContent('{"type":"final","content":"pong"}');
  assert.equal(content, "pong");
});

test("extractFinalContent can recover final json after prefixed reasoning text", () => {
  const content = extractFinalContent(
    'reasoning block {"ignored":"x"}\n{"type":"final","content":"clean answer"}',
  );
  assert.equal(content, "clean answer");
});

test("normalizeToolChoice handles required function selection", () => {
  const choice = normalizeToolChoice({
    type: "function",
    function: {
      name: "search_web",
    },
  });

  assert.deepEqual(choice, {
    mode: "required",
    name: "search_web",
  });
});
