import assert from "node:assert/strict";
import test from "node:test";

import { MetricsRegistry } from "../src/metrics.js";

test("metrics registry renders prometheus text with counters and gauges", async () => {
  const metrics = new MetricsRegistry();
  const finish = metrics.beginHttpRequest();
  metrics.recordGeneration("hello", "world");
  metrics.recordFailover();
  metrics.recordToolCall();
  metrics.setPoolState({
    active: 3,
    cooldown: 1,
    deleted: 2,
    total: 6,
    busy: 1,
  });
  finish();

  const text = metrics.renderPrometheus();

  assert.match(text, /anything2api_http_requests_total 1/);
  assert.match(text, /anything2api_generation_requests_total 1/);
  assert.match(text, /anything2api_generation_failovers_total 1/);
  assert.match(text, /anything2api_tool_calls_total 1/);
  assert.match(text, /anything2api_pool_active_accounts 3/);
  assert.match(text, /anything2api_pool_busy_accounts 1/);
  assert.match(text, /anything2api_estimated_prompt_tokens_total/);
});
