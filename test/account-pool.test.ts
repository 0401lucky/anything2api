import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function makeSession(suffix: string, dataDir: string): unknown {
  return {
    version: 1,
    accountId: `acct-${suffix}`,
    accountDir: path.join(dataDir, `acct-${suffix}`),
    email: `user${suffix}@example.com`,
    mailboxKey: "",
    userId: `user-${suffix}`,
    projectGroupId: `pg-${suffix}`,
    finalUrl: `https://www.anything.com/build/pg-${suffix}`,
    title: "Anything",
    createdAt: "2026-04-06 12:00:00",
    fingerprint: {
      version: 1,
      seed: suffix,
      userAgent: "ua",
      acceptLanguage: "zh-CN",
      locale: "zh-CN",
      platform: "Win32",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      colorScheme: "light",
      webglVendor: "vendor",
      webglRenderer: "renderer",
    },
  };
}

test("acquireAccount picks least-recently-used active account", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-acquire-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("1", tempDir) as never);
    await pool.addPreparedSession(makeSession("2", tempDir) as never);

    const first = await pool.acquireAccount();
    const second = await pool.acquireAccount(new Set([first.accountId]));
    assert.notEqual(first.accountId, second.accountId);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("markFailure cools down then deletes after threshold", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-failure-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  process.env.ACCOUNT_MAX_STRIKES = "2";

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("a", tempDir) as never);
    const account = await pool.acquireAccount();

    const cooled = await pool.markFailure(account.accountId, new Error("boom-1"));
    assert.equal(cooled?.status, "cooldown");
    assert.equal(cooled?.strikeCount, 1);

    const deleted = await pool.markFailure(account.accountId, new Error("boom-2"));
    assert.equal(deleted?.status, "deleted");
    assert.equal(deleted?.strikeCount, 2);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("acquireAccount throws when no active accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-empty-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});
    await assert.rejects(() => pool.acquireAccount(), /没有可用账号/);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("removeAccount drops the record entirely", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-remove-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("r1", tempDir) as never);
    const before = await pool.listAccounts();
    assert.equal(before.length, 1);

    await pool.removeAccount(before[0]!.accountId);
    const after = await pool.listAccounts();
    assert.equal(after.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reactivateAccount clears cooldown and deleted status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-react-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("ra", tempDir) as never);
    const account = await pool.acquireAccount();
    await pool.markFailure(account.accountId, new Error("x"));
    await pool.markFailure(account.accountId, new Error("y"));
    const accounts1 = await pool.listAccounts();
    assert.equal(accounts1[0]!.status, "deleted");

    const reactivated = await pool.reactivateAccount(account.accountId);
    assert.equal(reactivated?.status, "active");
    assert.equal(reactivated?.strikeCount, 0);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("updateSessionCookies persists refreshed cookies", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-cookies-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("ck", tempDir) as never);
    const account = await pool.acquireAccount();
    await pool.updateSessionCookies(account.accountId, [
      { name: "refresh_token", value: "new", domain: ".anything.com", path: "/" },
    ]);

    const accounts = await pool.listAccounts();
    assert.equal(accounts[0]?.cookies?.[0]?.value, "new");
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("markImmediateCooldown skips strike accumulation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pool-imm-"));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const { AccountPool } = await import(`../src/account-pool.js?case=${Date.now()}`);
    const pool = new AccountPool(() => {});

    await pool.addPreparedSession(makeSession("im", tempDir) as never);
    const account = await pool.acquireAccount();

    const cooled = await pool.markImmediateCooldown(account.accountId, new Error("429"), 1);
    assert.equal(cooled?.status, "cooldown");
    assert.equal(cooled?.strikeCount, 0);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});
