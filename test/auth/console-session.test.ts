import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleSessionStore, RateLimiter } from "../../src/auth/console-session.js";

test("ConsoleSessionStore issues unique cookies and validates them", () => {
  const store = new ConsoleSessionStore(60_000);
  const token = store.create("admin");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(store.validate(token)?.user, "admin");
  store.destroy(token);
  assert.equal(store.validate(token), null);
});

test("ConsoleSessionStore expires sessions after TTL", async () => {
  const store = new ConsoleSessionStore(10);
  const token = store.create("admin");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.validate(token), null);
});

test("RateLimiter blocks after maxAttempts within window", () => {
  const limiter = new RateLimiter(3, 60_000);
  assert.equal(limiter.recordFailureAndCheck("1.1.1.1"), true);
  assert.equal(limiter.recordFailureAndCheck("1.1.1.1"), true);
  assert.equal(limiter.recordFailureAndCheck("1.1.1.1"), true);
  assert.equal(limiter.recordFailureAndCheck("1.1.1.1"), false);
});
