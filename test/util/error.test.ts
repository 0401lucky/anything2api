import assert from "node:assert/strict";
import test from "node:test";

import { formatError } from "../../src/util/error.js";

test("formatError returns Error.message", () => {
  assert.equal(formatError(new Error("boom")), "boom");
});

test("formatError stringifies non-Error values", () => {
  assert.equal(formatError("oops"), "oops");
  assert.equal(formatError(42), "42");
  assert.equal(formatError(null), "null");
});
