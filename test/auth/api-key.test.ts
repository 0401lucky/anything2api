import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import test from "node:test";

import { checkApiKey, parseApiKeys } from "../../src/auth/api-key.js";

function makeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("parseApiKeys splits on commas and trims", () => {
  assert.deepEqual(parseApiKeys(" a, b ,c "), ["a", "b", "c"]);
  assert.deepEqual(parseApiKeys(""), []);
  assert.deepEqual(parseApiKeys(undefined), []);
});

test("checkApiKey accepts Bearer header", () => {
  assert.equal(checkApiKey(makeRequest({ authorization: "Bearer abc" }), ["abc"]), true);
});

test("checkApiKey accepts x-api-key header", () => {
  assert.equal(checkApiKey(makeRequest({ "x-api-key": "xyz" }), ["abc", "xyz"]), true);
});

test("checkApiKey rejects unknown key", () => {
  assert.equal(checkApiKey(makeRequest({ authorization: "Bearer wrong" }), ["abc"]), false);
});

test("checkApiKey rejects when no header present", () => {
  assert.equal(checkApiKey(makeRequest({}), ["abc"]), false);
});
