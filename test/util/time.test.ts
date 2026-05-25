import assert from "node:assert/strict";
import test from "node:test";

import { formatLocalTimestamp } from "../../src/util/time.js";

test("formatLocalTimestamp formats with zero-padded fields", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatLocalTimestamp(date), "2026-01-02 03:04:05");
});
