import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("account pool balances, cools down and deletes failing accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "anything-2api-pool-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const modulePath = `../src/account-pool.js?pooltest=${Date.now()}`;
    const { AccountPool } = await import(modulePath);

    let counter = 0;
    const pool = new AccountPool(
      () => {},
      {
        registerAndLogin: async () => {
          counter += 1;
          return {
            mailbox: { mail: `user${counter}@razkord.top`, key: `key-${counter}` },
            signupResult: { success: true, user: { id: `user-${counter}` }, projectGroup: { id: `pg-${counter}` } },
            mail: {
              status: "received",
              subject: "Magic Login Link",
              raw: "",
              headers: {},
              magicLink: "https://www.anything.com/auth/magic-link?code=1",
            },
            session: {
              version: 1,
              accountId: `acct-${counter}`,
              accountDir: path.join(tempDir, `acct-${counter}`),
              email: `user${counter}@razkord.top`,
              mailboxKey: `key-${counter}`,
              userId: `user-${counter}`,
              projectGroupId: `pg-${counter}`,
              finalUrl: `https://www.anything.com/build/pg-${counter}`,
              title: "Anything",
              createdAt: "2026-04-06 12:00:00",
              fingerprint: {
                version: 1,
                seed: `${counter}`,
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
            },
          };
        },
      },
    );

    await pool.ensureMinimumAccounts(2);
    const first = await pool.acquireAccount();
    const second = await pool.acquireAccount(new Set([first.accountId]));
    assert.notEqual(first.accountId, second.accountId);

    const cooled = await pool.markFailure(first.accountId, new Error("boom-1"));
    assert.equal(cooled?.status, "cooldown");
    assert.equal(cooled?.strikeCount, 1);

    const active = await pool.acquireAccount();
    assert.equal(active.accountId, second.accountId);

    const deleted = await pool.markFailure(first.accountId, new Error("boom-2"));
    assert.equal(deleted?.status, "deleted");
    assert.equal(deleted?.strikeCount, 2);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("account pool keeps refilling after a single registration failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "anything-2api-pool-retry-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;

  try {
    const modulePath = `../src/account-pool.js?poolretry=${Date.now()}`;
    const { AccountPool } = await import(modulePath);

    let calls = 0;
    const pool = new AccountPool(
      () => {},
      {
        registerAndLogin: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("welcome mail");
          }

          return {
            mailbox: { mail: "retry@razkord.top", key: "key-retry" },
            signupResult: { success: true, user: { id: "user-retry" }, projectGroup: { id: "pg-retry" } },
            mail: {
              status: "received",
              subject: "Magic Login Link",
              raw: "",
              headers: {},
              magicLink: "https://www.anything.com/auth/magic-link?code=1",
            },
            session: {
              version: 1,
              accountId: "acct-retry",
              accountDir: path.join(tempDir, "acct-retry"),
              email: "retry@razkord.top",
              mailboxKey: "key-retry",
              userId: "user-retry",
              projectGroupId: "pg-retry",
              finalUrl: "https://www.anything.com/build/pg-retry",
              title: "Anything",
              createdAt: "2026-04-06 12:00:00",
              fingerprint: {
                version: 1,
                seed: "retry",
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
            },
          };
        },
      },
    );

    await pool.ensureMinimumAccounts(1);
    const accounts = await pool.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.email, "retry@razkord.top");
    assert.equal(calls, 2);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
