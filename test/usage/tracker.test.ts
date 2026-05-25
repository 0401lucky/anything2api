import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageTracker } from "../../src/usage/tracker.js";

test("UsageTracker appends one JSON line per record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "usage-"));
  try {
    const tracker = new UsageTracker(path.join(dir, "stats.jsonl"), 50 * 1024 * 1024);
    await tracker.record({
      ts: new Date("2026-05-25T10:00:00Z"),
      accountId: "acct-1",
      model: "gpt-5.4",
      route: "/v1/chat/completions",
      promptChars: 100,
      completionChars: 200,
      status: "ok",
      latencyMs: 1200,
    });
    await tracker.record({
      ts: new Date("2026-05-25T10:00:01Z"),
      accountId: "acct-1",
      model: "gpt-5.4",
      route: "/v1/chat/completions",
      promptChars: 50,
      completionChars: 0,
      status: "error",
      errorKind: "timeout",
      latencyMs: 30000,
    });
    const raw = await readFile(path.join(dir, "stats.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.accountId, "acct-1");
    assert.equal(first.promptChars, 100);
    assert.equal(first.status, "ok");
    const second = JSON.parse(lines[1]!);
    assert.equal(second.status, "error");
    assert.equal(second.errorKind, "timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UsageTracker rotates oversized file at startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "usage-rotate-"));
  try {
    const target = path.join(dir, "stats.jsonl");
    await writeFile(target, "x".repeat(1024), "utf8");
    const tracker = new UsageTracker(target, 512);
    await tracker.maybeRotate();
    const rotatedStat = await stat(path.join(dir, "stats.jsonl.1"));
    assert.ok(rotatedStat.isFile());
    const liveStat = await stat(target);
    assert.equal(liveStat.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UsageTracker.aggregate summarizes by model and account", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "usage-agg-"));
  try {
    const target = path.join(dir, "stats.jsonl");
    const tracker = new UsageTracker(target, 50 * 1024 * 1024);
    for (let i = 0; i < 3; i += 1) {
      await tracker.record({
        ts: new Date("2026-05-25T10:00:00Z"),
        accountId: "acct-a",
        model: "gpt-5.4",
        route: "/v1/chat/completions",
        promptChars: 10,
        completionChars: 20,
        status: "ok",
        latencyMs: 100,
      });
    }
    const summary = await tracker.aggregate();
    assert.equal(summary.totalRequests, 3);
    assert.equal(summary.byModel["gpt-5.4"]?.requests, 3);
    assert.equal(summary.byAccount["acct-a"]?.requests, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
