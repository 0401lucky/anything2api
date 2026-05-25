# anything2api BYO Account 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 anything2api 从"批量注册账号"重构为"自带 Google 账号"模式：保留 OpenAI/Anthropic 兼容 2api + 账号池，新增 Web 控制台 + 容器内 noVNC 登录 + Docker 部署。

**Architecture:** 三层结构。底层 `AnythingProxyBackend` 持有 `AccountPool` + `BrowserSupervisor`（headless puppeteer 长跑）+ `VncSupervisor`（按需 spawn Xvfb/x11vnc/websockify + head-ful Chromium）；中层 `api-server` 暴露 `/v1/*`（API_KEYS 鉴权）与 `/admin/*`（控制台密码鉴权）两套路由；上层在容器里跑 Node + Chromium + Xvfb + noVNC，外部通过 Cloudflare Worker 反代访问。

**Tech Stack:** TypeScript 5 + Node.js 20 + 原生 `node:http` + puppeteer-extra(stealth) + node:test + Docker (Debian slim + chromium + xvfb + x11vnc + novnc + websockify) + 新依赖 `tar`、`ws`。

**Spec 来源:** `docs/superpowers/specs/2026-05-25-anything2api-byo-account-design.md`

---

## Task 0：初始化 Git 仓库

**Files:**
- Create: `.gitignore`
- Touch: 仓库根

**Why first**：项目当前不是 git 仓库（前期 brainstorming 已确认），但后续每个 task 都需要 commit。

- [ ] **Step 1: 创建 `.gitignore`**

```
node_modules/
dist/
data/
*.log
.DS_Store
.env
.env.local
registered_emails.txt
registered_results.jsonl
```

- [ ] **Step 2: 初始化仓库并做初始 commit**

```bash
git init
git add -A
git commit -m "chore: initial snapshot before BYO account refactor"
```

预期：`git log` 显示一个初始提交。

- [ ] **Step 3: 跑一次构建确认起点 OK**

```bash
npm install
npm run build
```

预期：`dist/` 目录生成，无 TS 错误。如果有错误，先修。本计划假设起点是绿的。

- [ ] **Step 4: 创建后续 task 用的目录占位**

```bash
mkdir -p src/util src/auth src/usage src/vnc src/console/static test/util test/auth test/usage test/console docs
```

---

## Task 1：抽离工具函数到 `src/util/`

**Files:**
- Create: `src/util/error.ts`
- Create: `src/util/time.ts`
- Create: `test/util/error.test.ts`
- Create: `test/util/time.test.ts`
- Modify: 所有 `import { formatError } from "./register.js"` 与 `import { formatLocalTimestamp } from "./register.js"` 改向 `./util/*`

**Why**：删除 `register.ts` 之前必须先把它被广泛引用的两个工具函数迁走。

- [ ] **Step 1: 写 `test/util/error.test.ts`**

```typescript
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
```

- [ ] **Step 2: 写 `test/util/time.test.ts`**

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { formatLocalTimestamp } from "../../src/util/time.js";

test("formatLocalTimestamp formats with zero-padded fields", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(formatLocalTimestamp(date), "2026-01-02 03:04:05");
});
```

- [ ] **Step 3: 跑测试确认失败（红）**

```bash
npm run build
```

预期：报 `Cannot find module '../../src/util/error.js'` 之类的编译错。

- [ ] **Step 4: 写 `src/util/error.ts`**

```typescript
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
```

- [ ] **Step 5: 写 `src/util/time.ts`**

```typescript
export function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
```

- [ ] **Step 6: 切换所有引用**

执行 `grep -rn "from \"./register.js\"" src/` 找出现位置，逐个把 `formatError` 和 `formatLocalTimestamp` 的 import 改成 `./util/error.js` 和 `./util/time.js`。

预期需要改的文件：`src/account.ts`、`src/account-pool.ts`、`src/api-server.ts`、`src/browser.ts`、`src/pool-expander.ts`、`src/pool-expander-worker.ts`、`src/cli.ts`。

注意：**保留 `register.ts` 自身**，不要删，本 task 仅迁移。继续从 `./register.js` 也能 re-export 这俩函数让旧引用兼容也是一种思路，但更干净的是直接把 import 改向 `./util/*`。

样例（`src/account.ts`）：

```typescript
// before
import {
  createTemporaryMailbox,
  formatError,
  formatLocalTimestamp,
  ...
} from "./register.js";

// after
import {
  createTemporaryMailbox,
  ...
} from "./register.js";
import { formatError } from "./util/error.js";
import { formatLocalTimestamp } from "./util/time.js";
```

- [ ] **Step 7: 跑测试和构建确认通过**

```bash
npm test
```

预期：所有测试通过（含新增的两个）。

- [ ] **Step 8: Commit**

```bash
git add src/util test/util src/account.ts src/account-pool.ts src/api-server.ts src/browser.ts src/pool-expander.ts src/pool-expander-worker.ts src/cli.ts
git commit -m "refactor: extract formatError/formatLocalTimestamp to src/util"
```

---

## Task 2：删除 `pool-expander` 自动补货线程

**Files:**
- Delete: `src/pool-expander.ts`
- Delete: `src/pool-expander-worker.ts`
- Modify: `src/api-server.ts`（删 BackgroundPoolExpander 引用、`startBackgroundExpansion`、`warmPoolInBackground`、`warmPool` 等）

**Why**：自动注册补货已不可行（anything.com 禁批量注册），先把后台 worker_threads 整条链拿掉，让构建仍然过。

- [ ] **Step 1: 删除两个文件**

```bash
rm src/pool-expander.ts src/pool-expander-worker.ts
```

- [ ] **Step 2: 改 `src/api-server.ts`**

把 `import { BackgroundPoolExpander } from "./pool-expander.js";` 整行删除。

把 `AnythingProxyBackend` 里：
- 字段 `private readonly expander: BackgroundPoolExpander;` 删除。
- 构造函数里 `this.expander = new BackgroundPoolExpander(this.pool, log);` 删除。
- 方法 `startBackgroundExpansion()` 删除。
- 方法 `warmPool()`、`warmPoolInBackground()` 删除（连同它们对 `this.pool.ensureReady` / `this.pool.warmInBackground` 的调用，因为 Task 3 会拿掉这些方法）。

`startApiServer` 里：

```typescript
// before
const backend = new AnythingProxyBackend(log);
backend.warmPoolInBackground();
backend.startBackgroundExpansion();

// after
const backend = new AnythingProxyBackend(log);
await backend.refreshPoolMetrics();
```

- [ ] **Step 3: 改 `src/api-server.ts` 里的 `generate` / `generateStreaming` 等方法**

把所有 `this.pool.warmInBackground(POOL_SIZE);` 删除（共 4 处：成功/失败各两个分支）。

把 `acquireFreeAccount` 里 `this.pool.warmInBackground(POOL_SIZE);` 删除。

- [ ] **Step 4: 编译确认通过**

```bash
npm run build
```

预期：无错。如果报 `Cannot find name 'POOL_SIZE'` 等剩余引用问题，按错误提示删除对应代码。

- [ ] **Step 5: 跑测试确认现有测试仍过**

```bash
npm test
```

预期：`account-pool.test.ts` 仍依赖 `pool.ensureMinimumAccounts(...)`，应该还能跑（下一 Task 才改这些）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove BackgroundPoolExpander worker threads"
```

---

## Task 3：删除 `register.ts`，断开 `account.ts` 对它的依赖

**Files:**
- Delete: `src/register.ts`
- Delete: `test/register.test.ts`
- Modify: `src/account.ts`（删 `registerAndLogin`、`loadOrCreateSession`、`AccountContext`、`tryLoadSessionFromPath`、`describeSessionError` 中需要清理的部分）
- Modify: `src/account-pool.ts`（删自动补货分支与 `registerAndLogin` 注入点）
- Modify: `test/account-pool.test.ts`（重写为不依赖 registerAndLogin 的测试）
- Modify: `src/cli.ts`（临时把 `register`/`login`/`pool-fill` 命令改成 throw "deprecated"，Task 15 再重写）
- Modify: `package.json`（删 register、pool:fill 脚本）

**Why**：彻底拔除批量注册血管。账号池只保留 acquire/markFailure/markSuccess/addPreparedSession/listAccounts/getSummary/removeAccount/reactivateAccount（后两个在 Task 4 再加）。

- [ ] **Step 1: 删文件**

```bash
rm src/register.ts test/register.test.ts
```

- [ ] **Step 2: 改 `src/account.ts`**

把整个文件改写成只保留与会话存取相关的部分：

```typescript
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StableFingerprint } from "./fingerprint.js";
import { formatError } from "./util/error.js";

export interface AccountSessionRecord {
  version: number;
  accountId: string;
  accountDir: string;
  email: string;
  mailboxKey: string;
  userId: string;
  projectGroupId: string;
  finalUrl: string;
  title: string;
  createdAt: string;
  fingerprint: StableFingerprint;
}

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
const LATEST_SESSION_PATH = path.join(DATA_DIR, "latest-session.json");

export async function loadLatestSession(): Promise<AccountSessionRecord | null> {
  try {
    const raw = await readFile(LATEST_SESSION_PATH, "utf8");
    return JSON.parse(raw) as AccountSessionRecord;
  } catch {
    return null;
  }
}

export async function saveLatestSession(session: AccountSessionRecord): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LATEST_SESSION_PATH, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function createAccountId(email: string): string {
  return createHash("sha1").update(email).digest("hex").slice(0, 12);
}

export function getAccountDir(email: string): string {
  const accountId = createAccountId(email);
  const safeEmail = email.replace(/[^a-z0-9@._-]+/gi, "_");
  return path.join(DATA_DIR, "accounts", `${safeEmail}-${accountId}`);
}

export function summarizeSession(session: AccountSessionRecord): string {
  return JSON.stringify(
    {
      email: session.email,
      userId: session.userId,
      projectGroupId: session.projectGroupId,
      finalUrl: session.finalUrl,
      accountDir: session.accountDir,
    },
    null,
    2,
  );
}

export async function tryLoadSessionFromPath(sessionPath: string): Promise<AccountSessionRecord> {
  const raw = await readFile(sessionPath, "utf8");
  return JSON.parse(raw) as AccountSessionRecord;
}

export function describeSessionError(error: unknown): string {
  return formatError(error);
}
```

注意：`AccountSessionRecord.mailboxKey` 字段保留为空字符串字段以保持 JSON 兼容（Task 14 的 `loginInteractive` 会写 `mailboxKey: ""`）。

- [ ] **Step 3: 改 `src/account-pool.ts`**

删除 `import { registerAndLogin, type AccountSessionRecord } from "./account.js";` 改为 `import type { AccountSessionRecord } from "./account.js";`。

构造函数签名简化：

```typescript
public constructor(
  private readonly log: (message: string) => void = console.log,
) {}
```

完全删除以下方法/字段：`ensureReady`、`warmInBackground`、`bootstrapPromise`、`startBootstrap`、`dependencies`、`ensureMinimumAccounts`、`ensureMinimumAccountsUnlocked`。

`acquireAccount` 改写：

```typescript
public async acquireAccount(excludedAccountIds: ReadonlySet<string> = new Set()): Promise<PoolAccountRecord> {
  return this.runExclusive(async () => {
    const state = await this.loadState();
    this.reactivateExpiredCooldowns(state);

    const candidates = state.accounts
      .filter((account) => account.status === "active")
      .filter((account) => !excludedAccountIds.has(account.accountId))
      .sort(compareByLeastRecentlyUsed);

    if (candidates.length === 0) {
      throw new Error("账号池中没有可用账号");
    }

    const selected = candidates[0]!;
    selected.lastUsedAt = formatLocalTimestamp(new Date());
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
    return selected;
  });
}
```

`compactState` 内引用 `REFILL_FAILURE_DELAY_MS`、`sleep` 等可以保留也可以删；只保留 compact 的核心截断逻辑。删除 `DEFAULT_POOL_SIZE` 与所有引用 `clampPoolSize` 的位置（保留 `MAX_POOL_SIZE` 控制截断）。

`AccountPoolState.desiredSize` 字段可保留（向后兼容），但不再被读取/更新。

- [ ] **Step 4: 重写 `test/account-pool.test.ts`**

不再用 `ensureMinimumAccounts` + `registerAndLogin` 注入，改为先用 `addPreparedSession` 灌账号，再断言 acquire / markFailure / markSuccess 行为。

```typescript
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
```

- [ ] **Step 5: 改 `src/cli.ts` 临时占位**

把 `register`、`login`、`pool-fill`、`pool-status`、`explore` 这些 case 改成：

```typescript
case "register":
case "login":
case "pool-fill":
  throw new Error("此命令将在 Task 15 重写。请直接跑 'serve'，账号通过控制台添加。");

case "pool-status":
  // 暂时保留：列出现有账号
  ...

case "explore":
  throw new Error("explore 命令已废弃");
```

- [ ] **Step 6: 改 `package.json` scripts**

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/src/cli.js serve",
    "serve": "node dist/src/cli.js serve",
    "pool:status": "node dist/src/cli.js pool-status",
    "discover-models": "node dist/src/discover-models.js",
    "test": "npm run build && node --test dist/test/**/*.test.js"
  }
}
```

注意 `test` 改用 glob 以包含 `dist/test/util/*.test.js` 等子目录。Windows / bash 都支持。

- [ ] **Step 7: 构建并跑测试**

```bash
npm run build
npm test
```

预期：所有测试通过。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove register.ts and self-refilling pool logic"
```

---

## Task 4：AccountPool 增加 removeAccount / reactivateAccount / markImmediateCooldown

**Files:**
- Modify: `src/account-pool.ts`
- Modify: `test/account-pool.test.ts`

**Why**：控制台 / CLI 需要"显式删除"和"从 cooldown 拉回 active"操作；切号策略需要"不计 strike 直接 cooldown"入口。

- [ ] **Step 1: 在 `test/account-pool.test.ts` 末尾追加测试**

```typescript
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
```

- [ ] **Step 2: 跑测试，三个新测试应失败**

```bash
npm test
```

预期：缺方法报错。

- [ ] **Step 3: 在 `src/account-pool.ts` 中实现三个方法**

```typescript
public async removeAccount(accountId: string): Promise<void> {
  await this.runExclusive(async () => {
    const state = await this.loadState();
    state.accounts = state.accounts.filter((account) => account.accountId !== accountId);
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
  });
}

public async reactivateAccount(accountId: string): Promise<PoolAccountRecord | null> {
  return this.runExclusive(async () => {
    const state = await this.loadState();
    const account = state.accounts.find((item) => item.accountId === accountId);
    if (!account) return null;
    account.status = "active";
    account.strikeCount = 0;
    account.cooldownUntil = null;
    account.lastError = null;
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
    return account;
  });
}

public async markImmediateCooldown(
  accountId: string,
  error: unknown,
  cooldownHours: number = ACCOUNT_COOLDOWN_HOURS,
): Promise<PoolAccountRecord | null> {
  return this.runExclusive(async () => {
    const state = await this.loadState();
    const account = state.accounts.find((item) => item.accountId === accountId);
    if (!account) return null;
    account.lastError = formatError(error);
    account.lastUsedAt = formatLocalTimestamp(new Date());
    account.status = "cooldown";
    account.cooldownUntil = formatLocalTimestamp(addHours(new Date(), cooldownHours));
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
    return account;
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test
```

预期：所有测试通过。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pool): add removeAccount, reactivateAccount, markImmediateCooldown"
```

---

## Task 5：API_KEYS 鉴权中间件

**Files:**
- Create: `src/auth/api-key.ts`
- Create: `test/auth/api-key.test.ts`

- [ ] **Step 1: 写 `test/auth/api-key.test.ts`**

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- --test-name-pattern="checkApiKey"
```

预期：模块不存在。

- [ ] **Step 3: 写 `src/auth/api-key.ts`**

```typescript
import type { IncomingMessage } from "node:http";

export function parseApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function checkApiKey(request: IncomingMessage, allowedKeys: readonly string[]): boolean {
  if (allowedKeys.length === 0) return false;

  const auth = pickHeader(request.headers["authorization"]);
  if (auth) {
    const lowered = auth.toLowerCase();
    if (lowered.startsWith("bearer ")) {
      const candidate = auth.slice(7).trim();
      if (allowedKeys.includes(candidate)) return true;
    }
  }

  const xApiKey = pickHeader(request.headers["x-api-key"]);
  if (xApiKey && allowedKeys.includes(xApiKey.trim())) return true;

  return false;
}

function pickHeader(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/auth test/auth
git commit -m "feat(auth): add API_KEYS authentication middleware"
```

---

## Task 6：接入 API_KEYS 中间件到 `/v1/*`

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: 在 `src/api-server.ts` 顶部加 import + 常量**

```typescript
import { checkApiKey, parseApiKeys } from "./auth/api-key.js";

const API_KEYS = parseApiKeys(process.env.API_KEYS);
const METRICS_TOKEN = process.env.METRICS_TOKEN?.trim() || null;
```

- [ ] **Step 2: 在 `startApiServer` 函数开头加启动校验**

```typescript
export async function startApiServer(log: (message: string) => void = console.log): Promise<void> {
  if (API_KEYS.length === 0) {
    log("[FATAL] API_KEYS 环境变量未设置；启动被拒。请配置 API_KEYS=key1,key2 后再启动。");
    process.exit(1);
  }
  ...
}
```

- [ ] **Step 3: 改 `routeRequest`，在 `/v1/*` 与 `/metrics` 入口加鉴权**

在 `routeRequest` 顶部，紧跟 URL 解析之后：

```typescript
const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

if (request.method === "GET" && url.pathname === "/healthz") {
  sendJson(response, 200, { ok: true });
  return;
}

if (request.method === "GET" && url.pathname === "/metrics") {
  if (METRICS_TOKEN) {
    const token =
      url.searchParams.get("token") ??
      (request.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "") ?? "");
    if (token !== METRICS_TOKEN) {
      sendJson(response, 401, { error: { message: "Unauthorized" } });
      return;
    }
  }
  await backend.refreshPoolMetrics();
  response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  response.end(backend.metrics.renderPrometheus());
  return;
}

// /admin/* 路由后续 Task 接入，先放行
if (url.pathname.startsWith("/admin/")) {
  sendJson(response, 503, { error: { message: "admin console not enabled in this build" } });
  return;
}

// /v1/* 鉴权
if (url.pathname.startsWith("/v1/") || url.pathname === "/v1/models") {
  if (!checkApiKey(request, API_KEYS)) {
    sendJson(response, 401, {
      error: { message: "Invalid or missing API key", type: "authentication_error" },
    });
    return;
  }
}

if (request.method !== "POST") {
  ...
}
```

- [ ] **Step 4: 构建并手动验证**

```bash
API_KEYS=test123 npm run build
API_KEYS=test123 npm run serve &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/v1/models    # 期望 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer test123" http://127.0.0.1:8787/v1/models  # 期望 200
kill %1
```

- [ ] **Step 5: 验证未设 API_KEYS 时拒启动**

```bash
node dist/src/cli.js serve  # 期望 exit 1，stderr 包含 "API_KEYS 环境变量未设置"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): enforce API_KEYS authentication on /v1/* and /metrics"
```

---

## Task 7：UsageTracker（追加 `data/usage-stats.jsonl`）

**Files:**
- Create: `src/usage/tracker.ts`
- Create: `test/usage/tracker.test.ts`

- [ ] **Step 1: 写 `test/usage/tracker.test.ts`**

```typescript
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
```

- [ ] **Step 2: 写 `src/usage/tracker.ts`**

```typescript
import { appendFile, rename, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface UsageRecord {
  ts: Date;
  accountId: string;
  model: string;
  route: string;
  promptChars: number;
  completionChars: number;
  status: "ok" | "error";
  errorKind?: string;
  latencyMs: number;
}

export interface UsageSummary {
  totalRequests: number;
  byModel: Record<string, { requests: number; promptChars: number; completionChars: number }>;
  byAccount: Record<string, { requests: number; promptChars: number; completionChars: number }>;
}

export class UsageTracker {
  public constructor(private readonly filePath: string, private readonly maxBytes: number) {}

  public async record(entry: UsageRecord): Promise<void> {
    const line = JSON.stringify({
      ts: entry.ts.toISOString(),
      accountId: entry.accountId,
      model: entry.model,
      route: entry.route,
      promptChars: entry.promptChars,
      completionChars: entry.completionChars,
      status: entry.status,
      ...(entry.errorKind ? { errorKind: entry.errorKind } : {}),
      latencyMs: entry.latencyMs,
    });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${line}\n`, "utf8");
  }

  public async maybeRotate(): Promise<void> {
    try {
      const stats = await stat(this.filePath);
      if (stats.size <= this.maxBytes) return;
      await rename(this.filePath, `${this.filePath}.1`);
      await writeFile(this.filePath, "", "utf8");
    } catch {
      // not present, ignore
    }
  }

  public async aggregate(): Promise<UsageSummary> {
    const summary: UsageSummary = {
      totalRequests: 0,
      byModel: {},
      byAccount: {},
    };
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return summary;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as UsageRecord;
        summary.totalRequests += 1;

        const modelKey = entry.model || "unknown";
        const mb = (summary.byModel[modelKey] ??= { requests: 0, promptChars: 0, completionChars: 0 });
        mb.requests += 1;
        mb.promptChars += entry.promptChars ?? 0;
        mb.completionChars += entry.completionChars ?? 0;

        const acctKey = entry.accountId || "unknown";
        const ab = (summary.byAccount[acctKey] ??= { requests: 0, promptChars: 0, completionChars: 0 });
        ab.requests += 1;
        ab.promptChars += entry.promptChars ?? 0;
        ab.completionChars += entry.completionChars ?? 0;
      } catch {
        // skip malformed
      }
    }

    return summary;
  }
}
```

- [ ] **Step 3: 跑测试通过**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add src/usage test/usage
git commit -m "feat(usage): add UsageTracker for jsonl stats"
```

---

## Task 8：UsageTracker 接入生成路径

**Files:**
- Modify: `src/api-server.ts`

- [ ] **Step 1: 在 `src/api-server.ts` 顶部加 import + 常量**

```typescript
import { UsageTracker } from "./usage/tracker.js";

const USAGE_FILE = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data", "usage-stats.jsonl");
const USAGE_MAX_BYTES = Number.parseInt(process.env.USAGE_MAX_BYTES ?? `${50 * 1024 * 1024}`, 10);
const USAGE_ENABLED = (process.env.ENABLE_USAGE_STATS ?? "true").toLowerCase() !== "false";
```

- [ ] **Step 2: 在 `AnythingProxyBackend` 加字段**

```typescript
private readonly usage: UsageTracker | null;

public constructor(private readonly log: (message: string) => void) {
  this.pool = new AccountPool(log);
  this.usage = USAGE_ENABLED ? new UsageTracker(USAGE_FILE, USAGE_MAX_BYTES) : null;
}
```

- [ ] **Step 3: 在 `startApiServer` 启动时 rotate**

```typescript
const backend = new AnythingProxyBackend(log);
await backend.maybeRotateUsage();
```

加 `AnythingProxyBackend.maybeRotateUsage()`：

```typescript
public async maybeRotateUsage(): Promise<void> {
  if (this.usage) await this.usage.maybeRotate();
}
```

- [ ] **Step 4: 改 `generateOnce` 包一层 try/catch 记录**

```typescript
private async generateOnce(...): Promise<{ text: string; model: string; account: PoolAccountRecord }> {
  const startedAt = Date.now();
  try {
    const browser = await this.ensureBrowser(account);
    const resolvedModel = resolveModel(model);
    const result = await generateProjectGroupRevisionViaGraphql({ ... });
    await persistTrace({ ... });
    this.metrics.recordGeneration(prompt, result.response.trim());

    const finalText = result.response.trim();
    await this.usage?.record({
      ts: new Date(),
      accountId: account.accountId,
      model: resolvedModel.canonical,
      route: "/v1",
      promptChars: prompt.length,
      completionChars: finalText.length,
      status: "ok",
      latencyMs: Date.now() - startedAt,
    });

    return { text: finalText, model: resolvedModel.canonical, account };
  } catch (error) {
    await this.usage?.record({
      ts: new Date(),
      accountId: account.accountId,
      model: model ?? "unknown",
      route: "/v1",
      promptChars: prompt.length,
      completionChars: 0,
      status: "error",
      errorKind: error instanceof Error ? error.constructor.name : "Unknown",
      latencyMs: Date.now() - startedAt,
    });
    throw error;
  }
}
```

- [ ] **Step 5: 构建并手动验证**

```bash
API_KEYS=test npm run build
API_KEYS=test npm run serve &
sleep 2
# 触发一次（即使失败也会记录）
curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer test" \
  -d '{"model":"anything-auto","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8787/v1/chat/completions > /dev/null
kill %1
cat data/usage-stats.jsonl  # 期望看到一行 JSON
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(usage): record per-request stats from generateOnce"
```

---

## Task 9：切号策略扩展（IMMEDIATE_SWITCH_STATUS_CODES + SWITCH_ON_USES）

**Files:**
- Modify: `src/browser.ts`（GraphQL 错误透传 HTTP 状态码）
- Modify: `src/api-server.ts`（解析状态码 + 主动轮转 + 调 markImmediateCooldown）
- Modify: `src/account-pool.ts`（追加 useCount 字段 + SWITCH_ON_USES 触发轮转）

- [ ] **Step 1: 改 `src/browser.ts` 的 `graphqlRequest`**

让它在 fetch 非 2xx 时抛带状态码的错误：

```typescript
async function graphqlRequest(
  page: Page,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const probe = await page.evaluate(async (requestPayload) => {
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/graphql-response+json,application/json;q=0.9",
        "content-type": "application/json",
        "apollographql-client-name": "flux-web",
      },
      body: JSON.stringify(requestPayload),
    });
    const text = await response.text();
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      text,
    };
  }, payload);

  if (probe.status < 200 || probe.status >= 300) {
    const err = new Error(
      `GraphQL HTTP ${probe.status}: ${truncate(probe.text, 300) ?? ""}`,
    ) as Error & { status?: number; retryAfter?: string | null };
    err.status = probe.status;
    err.retryAfter = probe.retryAfter;
    throw err;
  }

  try {
    return JSON.parse(probe.text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`GraphQL 返回了无效 JSON: ${formatError(error)} / ${truncate(probe.text, 500)}`);
  }
}
```

- [ ] **Step 2: 在 `src/account-pool.ts` 中加 `consecutiveUses`**

`PoolAccountRecord` 增字段：

```typescript
export interface PoolAccountRecord extends AccountSessionRecord {
  status: PoolAccountStatus;
  strikeCount: number;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  consecutiveUses: number;
}
```

`addPreparedSession` 初始化 `consecutiveUses: 0`。`acquireAccount` 选中后：

```typescript
selected.consecutiveUses += 1;
selected.lastUsedAt = formatLocalTimestamp(new Date());
```

`markSuccess` 中：当 `consecutiveUses >= SWITCH_ON_USES` 时把 `consecutiveUses` 归零，并把该账号的 `lastUsedAt` 置为很久以前（让 LRU 排序自然把它排到最后）。

```typescript
const SWITCH_ON_USES = parsePositiveInteger(process.env.SWITCH_ON_USES, 40);

public async markSuccess(accountId: string): Promise<void> {
  await this.runExclusive(async () => {
    const state = await this.loadState();
    const account = state.accounts.find((item) => item.accountId === accountId);
    if (!account) return;

    account.lastError = null;
    account.lastUsedAt = formatLocalTimestamp(new Date());
    if (account.status !== "deleted") {
      account.status = "active";
      account.cooldownUntil = null;
    }
    if (SWITCH_ON_USES > 0 && account.consecutiveUses >= SWITCH_ON_USES) {
      account.consecutiveUses = 0;
      // force LRU sink: 把 lastUsedAt 设到 +∞ 的语义可以用一个稍微特殊的标记，但简单做法是不动
      // 之后下次 acquire 仍按 LRU 选最少使用者
    }
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
  });
}
```

`markFailure` 与 `markImmediateCooldown` 都把 `consecutiveUses = 0`，具体改动如下：

```typescript
public async markFailure(accountId: string, error: unknown): Promise<PoolAccountRecord | null> {
  return this.runExclusive(async () => {
    const state = await this.loadState();
    const account = state.accounts.find((item) => item.accountId === accountId);
    if (!account) return null;

    account.strikeCount += 1;
    account.consecutiveUses = 0;
    account.lastError = formatError(error);
    account.lastUsedAt = formatLocalTimestamp(new Date());

    if (account.strikeCount >= ACCOUNT_MAX_STRIKES) {
      account.status = "deleted";
      account.cooldownUntil = null;
      this.log(`[-] 账号已删除: ${account.email} strikes=${account.strikeCount}`);
    } else {
      account.status = "cooldown";
      account.cooldownUntil = formatLocalTimestamp(addHours(new Date(), ACCOUNT_COOLDOWN_HOURS));
      this.log(`[!] 账号进入 cooldown: ${account.email} until=${account.cooldownUntil}`);
    }

    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
    return account;
  });
}

public async markImmediateCooldown(
  accountId: string,
  error: unknown,
  cooldownHours: number = ACCOUNT_COOLDOWN_HOURS,
): Promise<PoolAccountRecord | null> {
  return this.runExclusive(async () => {
    const state = await this.loadState();
    const account = state.accounts.find((item) => item.accountId === accountId);
    if (!account) return null;
    account.consecutiveUses = 0;
    account.lastError = formatError(error);
    account.lastUsedAt = formatLocalTimestamp(new Date());
    account.status = "cooldown";
    account.cooldownUntil = formatLocalTimestamp(addHours(new Date(), cooldownHours));
    state.updatedAt = formatLocalTimestamp(new Date());
    await this.saveState(state);
    return account;
  });
}
```

`addPreparedSession` 在 record 字面量中补默认值：

```typescript
const record: PoolAccountRecord = {
  ...session,
  status: "active",
  strikeCount: 0,
  cooldownUntil: null,
  lastError: null,
  lastUsedAt: null,
  consecutiveUses: 0,
};
```

`reactivateAccount` 重置：

```typescript
account.consecutiveUses = 0;
```

- [ ] **Step 3: 改 `src/api-server.ts` 的错误分流**

```typescript
const IMMEDIATE_SWITCH_STATUS_CODES = new Set(
  (process.env.IMMEDIATE_SWITCH_STATUS_CODES ?? "429,403,401")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0),
);
const ACCOUNT_COOLDOWN_HOURS = Number.parseInt(process.env.ACCOUNT_COOLDOWN_HOURS ?? "12", 10);
```

在 `generate` 与 `generateStreaming` 的 catch 分支里：

```typescript
} catch (error) {
  lastError = error;
  this.log(`[-] 账号执行失败: ${account.email} / ${formatError(error)}`);

  const status = (error as { status?: number } | undefined)?.status;
  if (typeof status === "number" && IMMEDIATE_SWITCH_STATUS_CODES.has(status)) {
    const retryAfter = (error as { retryAfter?: string | null }).retryAfter ?? null;
    const cooldownHours = computeCooldownHours(retryAfter, ACCOUNT_COOLDOWN_HOURS);
    await this.pool.markImmediateCooldown(account.accountId, error, cooldownHours);
  } else {
    await this.pool.markFailure(account.accountId, error);
  }

  this.metrics.recordFailover();
  await this.disposeBrowser(account.accountId);
  this.refreshPoolMetrics();
}
```

在 `api-server.ts` 文件底部加：

```typescript
function computeCooldownHours(retryAfter: string | null, fallbackHours: number): number {
  if (!retryAfter) return fallbackHours;
  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(fallbackHours, Math.max(1, Math.ceil(seconds / 3600)));
  }
  return fallbackHours;
}
```

- [ ] **Step 4: 构建并跑测试**

```bash
npm test
```

预期：现有测试全部通过（`consecutiveUses` 字段在测试 fixture 里不显式提供，addPreparedSession 会补 0）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pool): immediate cooldown on 401/403/429 and switch-on-uses rotation"
```

---

## Task 10：流式 fake 模式

**Files:**
- Modify: `src/streaming.ts`
- Modify: `src/api-server.ts`
- Modify: `src/model-catalog.ts`（支持 `-real` / `-fake` 后缀）

- [ ] **Step 1: 改 `src/model-catalog.ts`，加 streaming 偏好**

```typescript
export interface ResolvedModel {
  requested: string;
  canonical: string;
  preferredGenerationProvider: string | null;
  streamingMode: "real" | "fake" | "default";
}

export function resolveModel(input: string | undefined): ResolvedModel {
  const raw = (input ?? "").trim();
  const lower = raw.toLowerCase();

  let stripped = lower;
  let streamingMode: ResolvedModel["streamingMode"] = "default";
  if (stripped.endsWith("-fake")) {
    stripped = stripped.slice(0, -"-fake".length);
    streamingMode = "fake";
  } else if (stripped.endsWith("-real")) {
    stripped = stripped.slice(0, -"-real".length);
    streamingMode = "real";
  }

  const alias = MODEL_ALIASES[stripped];
  if (alias) return { ...alias, streamingMode };

  return {
    requested: raw || "anything-auto",
    canonical: raw || "anything-auto",
    preferredGenerationProvider: null,
    streamingMode,
  };
}
```

注意：把每个 `MODEL_ALIASES[xxx]` 字面量都补上 `streamingMode: "default"`（或在常量后立即扩展），最简单做法是在 `MODEL_ALIASES` 后加：

```typescript
for (const key of Object.keys(MODEL_ALIASES)) {
  (MODEL_ALIASES as Record<string, ResolvedModel>)[key] = {
    ...(MODEL_ALIASES[key] as ResolvedModel),
    streamingMode: "default",
  };
}
```

- [ ] **Step 2: 在 `src/api-server.ts` 顶部加全局开关**

```typescript
const STREAMING_MODE_DEFAULT = (process.env.STREAMING_MODE ?? "real").toLowerCase() === "fake" ? "fake" : "real";

function resolveStreamingMode(modelHint: string | undefined): "real" | "fake" {
  const resolved = resolveModel(modelHint);
  if (resolved.streamingMode === "default") return STREAMING_MODE_DEFAULT;
  return resolved.streamingMode;
}
```

- [ ] **Step 3: 改各 stream 函数**

每个 `streamChatCompletions / streamLegacyCompletion / streamResponses / streamAnthropicMessages` 顶部加：

```typescript
const mode = resolveStreamingMode(model);
if (mode === "fake") {
  await streamChatCompletionsFake(response, backend, prompt, model, tools, toolChoice);
  return;
}
// 继续走原流程
```

在文件下方加 fake 实现（以 chat 为例）：

```typescript
async function streamChatCompletionsFake(
  response: ServerResponse<IncomingMessage>,
  backend: AnythingProxyBackend,
  prompt: string,
  model: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): Promise<void> {
  setupSse(response);
  const toolResult = await generateWithOptionalTools({ backend, prompt, model, tools, toolChoice });
  if (toolResult.toolCall) {
    backend.metrics.recordToolCall();
    writeOpenAIChatToolCallDelta(
      response,
      toolResult.toolCall,
      toolResult.toolCall.name,
      toolResult.toolCall.argumentsText,
      toolResult.model,
    );
    writeOpenAIFinish(response, "tool_calls", toolResult.model);
    endSse(response);
    return;
  }

  const chunkSize = 64;
  for (let i = 0; i < toolResult.text.length; i += chunkSize) {
    writeOpenAIChatTextDelta(response, toolResult.text.slice(i, i + chunkSize), toolResult.model);
  }
  writeOpenAIFinish(response, "stop", toolResult.model);
  endSse(response);
}
```

依葫芦画瓢实现 `streamLegacyCompletionFake`、`streamResponsesFake`、`streamAnthropicMessagesFake`，结构相同（一次性 generate，再分块吐）。

- [ ] **Step 4: 构建确认**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(streaming): add STREAMING_MODE=fake + per-model -real/-fake suffix"
```

---

## Task 11：browser.ts 增加 head-ful + display 参数 + runInteractiveLogin

**Files:**
- Modify: `src/browser.ts`

- [ ] **Step 1: 改 `LaunchOptions` 与 `launchBrowser`**

```typescript
interface LaunchOptions {
  accountDir: string;
  fingerprint: StableFingerprint;
  headless?: boolean;
  display?: string;
}

async function launchBrowser(options: LaunchOptions): Promise<Browser> {
  await mkdir(path.join(options.accountDir, "user-data"), { recursive: true });

  const headless = options.headless ?? (HEADLESS_MODE !== "false");
  const env = options.display ? { ...process.env, DISPLAY: options.display } : process.env;

  return puppeteerExtra.launch({
    headless,
    ignoreHTTPSErrors: true,
    userDataDir: path.join(options.accountDir, "user-data"),
    defaultViewport: null,
    env,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationHints,MediaRouter",
      `--window-size=${options.fingerprint.viewport.width},${options.fingerprint.viewport.height}`,
    ],
  });
}
```

`puppeteer-extra` 的 LaunchOptions 是否支持 `env` 取决于版本；如果不支持，则在 `process.env.DISPLAY = options.display` 设置后立即恢复。安全做法：

```typescript
const prevDisplay = process.env.DISPLAY;
if (options.display) process.env.DISPLAY = options.display;
try {
  return await puppeteerExtra.launch({ ... });
} finally {
  if (options.display) {
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
  }
}
```

- [ ] **Step 2: 改 `openBrowserSession` 签名透传**

```typescript
export async function openBrowserSession(
  accountDir: string,
  fingerprint: StableFingerprint,
  options: { headless?: boolean; display?: string } = {},
): Promise<BrowserSessionHandle> {
  const browser = await launchBrowser({
    accountDir,
    fingerprint,
    headless: options.headless,
    display: options.display,
  });
  return { browser, accountDir, fingerprint };
}
```

- [ ] **Step 3: 新增 `runInteractiveLogin`**

```typescript
export interface InteractiveLoginResult {
  finalUrl: string;
  title: string;
  userId: string;
  email: string;
  projectGroupId: string;
}

export async function runInteractiveLogin(options: {
  handle: BrowserSessionHandle;
  log?: (message: string) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<InteractiveLoginResult> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const page = await options.handle.browser.newPage();
  await preparePage(page, options.handle.fingerprint);
  await page.goto(`${ANYTHING_BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("登录已被取消");
      await delay(pollMs);

      const url = page.url();
      if (!url.startsWith(ANYTHING_BASE_URL)) continue;
      if (url.match(/\/(login|signup|auth)(\/|$|\?)/i)) continue;

      const cookies = await page.cookies();
      if (!cookies.find((c) => c.name === "lS_authToken" && c.value)) continue;

      try {
        const meResponse = await graphqlRequest(page, {
          operationName: "Me",
          variables: {},
          extensions: { clientLibrary: { name: "@apollo/client", version: "4.1.6" } },
          query: `query Me { me { id email displayName __typename } }`,
        });
        const me = (meResponse as { data?: { me?: { id?: string; email?: string } } }).data?.me;
        if (!me?.id || !me.email) continue;

        const groupResponse = await graphqlRequest(page, {
          operationName: "GetProjectGroups",
          variables: {
            organizationId: null,
            input: { organizationId: null, orderBy: { field: "UPDATED_AT", direction: "DESC" } },
          },
          extensions: { clientLibrary: { name: "@apollo/client", version: "4.1.6" } },
          query: `query GetProjectGroups($organizationId: ID, $input: ProjectGroupsInput!) {
            projectGroups(input: $input) { edges { node { id name __typename } __typename } __typename }
          }`,
        });
        const edges =
          (groupResponse as { data?: { projectGroups?: { edges?: Array<{ node?: { id?: string } }> } } })
            .data?.projectGroups?.edges ?? [];
        const projectGroupId = edges[0]?.node?.id;
        if (!projectGroupId) {
          log("[!] 当前账号还没有任何项目，请到 anything.com 主页新建一个项目后回到本页继续。");
          continue;
        }

        return {
          finalUrl: url,
          title: await page.title(),
          userId: me.id,
          email: me.email,
          projectGroupId,
        };
      } catch (error) {
        log(`[!] 登录校验失败，继续等待: ${formatError(error)}`);
      }
    }

    throw new Error("登录超时");
  } finally {
    await page.close().catch(() => undefined);
  }
}
```

注意：上面的 GetProjectGroups 用了 `organizationId: null`——这是简化版查询，实际 anything.com 可能要求传具体 orgId。**真实形态需要根据登录后的协议观察调整**。如果失败，回退方案是：登录完成后直接读 `me.organizations` 拿到 orgId，再查。这里先按当前协议草案写。

- [ ] **Step 4: 构建确认**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/browser.ts
git commit -m "feat(browser): add headless+display options and runInteractiveLogin"
```

---

## Task 12：account.ts 实现 `loginInteractive`

**Files:**
- Modify: `src/account.ts`

- [ ] **Step 1: 在 `src/account.ts` 加 import 与新函数**

```typescript
import { closeBrowserSession, openBrowserSession, runInteractiveLogin } from "./browser.js";
import { loadOrCreateFingerprint } from "./fingerprint.js";
import { formatLocalTimestamp } from "./util/time.js";

export interface LoginInteractiveOptions {
  display?: string;
  headless?: boolean;
  log?: (message: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function loginInteractive(
  options: LoginInteractiveOptions = {},
): Promise<AccountSessionRecord> {
  const log = options.log ?? console.log;

  // 用临时邮箱位作为初始 accountDir 句柄
  const tempDir = path.join(DATA_DIR, "pending", `login-${Date.now()}`);
  const tempFingerprint = await loadOrCreateFingerprint(tempDir, `pending-${Date.now()}`);
  const handle = await openBrowserSession(tempDir, tempFingerprint, {
    headless: options.headless ?? false,
    display: options.display,
  });

  try {
    log(`[*] 等待 Google 登录 anything.com ...`);
    const result = await runInteractiveLogin({
      handle,
      log,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    const targetDir = getAccountDir(result.email);
    await mkdir(targetDir, { recursive: true });

    // 把临时目录里的 user-data + fingerprint 移过去
    const { rename } = await import("node:fs/promises");
    await rename(path.join(tempDir, "user-data"), path.join(targetDir, "user-data"));
    await rename(path.join(tempDir, "fingerprint.json"), path.join(targetDir, "fingerprint.json"));

    const finalFingerprint = await loadOrCreateFingerprint(targetDir, result.email);

    const session: AccountSessionRecord = {
      version: 1,
      accountId: createAccountId(result.email),
      accountDir: targetDir,
      email: result.email,
      mailboxKey: "",
      userId: result.userId,
      projectGroupId: result.projectGroupId,
      finalUrl: result.finalUrl,
      title: result.title,
      createdAt: formatLocalTimestamp(new Date()),
      fingerprint: finalFingerprint,
    };

    await writeFile(path.join(targetDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await saveLatestSession(session);
    log(`[+] 账号会话已保存: ${path.join(targetDir, "session.json")}`);
    return session;
  } finally {
    await closeBrowserSession(handle);
    // 清理 pending 目录残留
    const { rm } = await import("node:fs/promises");
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

- [ ] **Step 2: 构建确认**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/account.ts
git commit -m "feat(account): implement loginInteractive for manual Google login"
```

---

## Task 13：CLI 重写 `login` + `accounts:*`

> **执行顺序说明：** 本 Task 依赖 Task 14（packager）已完成。如果用 subagent-driven 模式执行，请 **先做 Task 14 再做 Task 13**，或者按文档顺序执行时把 `packAccount` / `unpackAccount` 的 import 暂时注释，等 Task 14 完成后再取消注释并 commit。

**Files:**
- Modify: `src/cli.ts`
- Modify: `package.json`

- [ ] **Step 1: 重写 `src/cli.ts`**

```typescript
import { AccountPool } from "./account-pool.js";
import { startApiServer } from "./api-server.js";
import { loadLatestSession, loginInteractive, summarizeSession, tryLoadSessionFromPath } from "./account.js";
import { packAccount, unpackAccount } from "./auth/packager.js";
import { formatError } from "./util/error.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";

  switch (command) {
    case "serve": {
      await startApiServer(console.log);
      return;
    }

    case "login": {
      const session = await loginInteractive({ log: console.log });
      console.log(summarizeSession(session));
      // 顺手挂到 pool 里
      const pool = new AccountPool(console.log);
      await pool.addPreparedSession(session);
      return;
    }

    case "accounts": {
      const sub = process.argv[3] ?? "list";
      const pool = new AccountPool(console.log);

      if (sub === "list") {
        const accounts = await pool.listAccounts();
        console.log(JSON.stringify(accounts, null, 2));
        return;
      }

      if (sub === "remove") {
        const id = process.argv[4];
        if (!id) throw new Error("用法: accounts remove <accountId>");
        await pool.removeAccount(id);
        return;
      }

      if (sub === "reactivate") {
        const id = process.argv[4];
        if (!id) throw new Error("用法: accounts reactivate <accountId>");
        const result = await pool.reactivateAccount(id);
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (sub === "export") {
        const id = process.argv[4];
        const out = process.argv[5];
        if (!id || !out) throw new Error("用法: accounts export <accountId> <out.tar.gz>");
        const accounts = await pool.listAccounts();
        const account = accounts.find((a) => a.accountId === id);
        if (!account) throw new Error(`未找到账号: ${id}`);
        await packAccount(account.accountDir, out);
        console.log(`已导出到 ${out}`);
        return;
      }

      if (sub === "import") {
        const archive = process.argv[4];
        if (!archive) throw new Error("用法: accounts import <archive.tar.gz>");
        const accountDir = await unpackAccount(archive);
        const sessionPath = `${accountDir}/session.json`;
        const session = await tryLoadSessionFromPath(sessionPath);
        await pool.addPreparedSession(session);
        console.log(`已导入: ${session.email} → ${accountDir}`);
        return;
      }

      throw new Error(`accounts 子命令未知: ${sub}`);
    }

    case "pool-status": {
      const pool = new AccountPool(console.log);
      const accounts = await pool.listAccounts();
      console.log(JSON.stringify(accounts, null, 2));
      return;
    }

    default:
      throw new Error(`未知命令: ${command}`);
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${formatError(error)}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: 改 `package.json` scripts**

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/src/cli.js serve",
    "serve": "node dist/src/cli.js serve",
    "login": "node dist/src/cli.js login",
    "accounts:list": "node dist/src/cli.js accounts list",
    "accounts:remove": "node dist/src/cli.js accounts remove",
    "accounts:reactivate": "node dist/src/cli.js accounts reactivate",
    "accounts:export": "node dist/src/cli.js accounts export",
    "accounts:import": "node dist/src/cli.js accounts import",
    "pool:status": "node dist/src/cli.js pool-status",
    "discover-models": "node dist/src/discover-models.js",
    "test": "npm run build && node --test dist/test/**/*.test.js"
  }
}
```

注意：本 Task 暂未实现 Task 14 的 packager，构建会失败。所以应该把 Task 13 与 Task 14 顺序调换或合并。**这里采用：先做 Task 14，再做 Task 13**——所以执行此计划时，请按 Task 编号 14 → 13 的顺序操作，或者把 Task 13 的 cli.ts 中的 packAccount/unpackAccount 引用临时注释，等 Task 14 完成后再启用。

为避免混淆，**实际执行顺序：Task 14 在前，Task 13 在后**。本计划中我把 Task 14 紧跟 Task 13 列出但读者执行时按 14 → 13。

- [ ] **Step 3: 构建（假设 Task 14 已完成）**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts package.json
git commit -m "feat(cli): rewrite login + add accounts subcommands"
```

---

## Task 14：`auth/packager.ts` (tar.gz 打包/解包账号目录)

**Files:**
- Create: `src/auth/packager.ts`
- Create: `test/auth/packager.test.ts`
- Modify: `package.json`（加 dep `tar`）

- [ ] **Step 1: 加依赖**

```bash
npm install tar
npm install --save-dev @types/tar
```

- [ ] **Step 2: 写 `test/auth/packager.test.ts`**

```typescript
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { packAccount, unpackAccount } from "../../src/auth/packager.js";

test("packAccount + unpackAccount roundtrips a directory", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pkg-"));
  try {
    const src = path.join(work, "acct-source");
    await mkdir(path.join(src, "user-data"), { recursive: true });
    await writeFile(path.join(src, "session.json"), JSON.stringify({ email: "a@b.c" }), "utf8");
    await writeFile(path.join(src, "user-data", "Cookies"), "binary-blob", "utf8");

    const archive = path.join(work, "acct.tar.gz");
    await packAccount(src, archive);

    const stat = await readFile(archive);
    assert.ok(stat.length > 0);

    const restored = await unpackAccount(archive, path.join(work, "restored"));
    const session = JSON.parse(await readFile(path.join(restored, "session.json"), "utf8"));
    assert.equal(session.email, "a@b.c");
    const cookies = await readFile(path.join(restored, "user-data", "Cookies"), "utf8");
    assert.equal(cookies, "binary-blob");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("unpackAccount rejects entries with parent paths", async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), "pkg-evil-"));
  try {
    // 构造一个含 '../escape' 路径的 tar.gz
    const archive = path.join(work, "evil.tar.gz");
    const tar = await import("tar");
    const src = path.join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "ok.txt"), "x", "utf8");
    await tar.c({ gzip: true, file: archive, cwd: src }, ["ok.txt"]);

    // 正常解包应成功（这里只验证 unpackAccount 不会接收形如 ../的条目；
    //  细化测试需要构造恶意 tar，省略，留集成测试）
    const restored = await unpackAccount(archive, path.join(work, "out"));
    const restoredContent = await readFile(path.join(restored, "ok.txt"), "utf8");
    assert.equal(restoredContent, "x");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: 写 `src/auth/packager.ts`**

```typescript
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as tar from "tar";

export async function packAccount(sourceDir: string, archivePath: string): Promise<void> {
  await mkdir(path.dirname(archivePath), { recursive: true });
  const parent = path.dirname(sourceDir);
  const folder = path.basename(sourceDir);
  await tar.c(
    {
      gzip: true,
      file: archivePath,
      cwd: parent,
      portable: true,
    },
    [folder],
  );
}

export async function unpackAccount(archivePath: string, targetParent?: string): Promise<string> {
  const dest = targetParent
    ? (await mkdir(targetParent, { recursive: true }), targetParent)
    : await mkdtemp(path.join(os.tmpdir(), "anything-account-"));
  let firstEntry: string | undefined;

  await tar.x({
    gzip: true,
    file: archivePath,
    cwd: dest,
    strict: true,
    filter: (entryPath) => {
      const normalized = path.normalize(entryPath);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        throw new Error(`非法 tar 路径: ${entryPath}`);
      }
      if (!firstEntry) firstEntry = entryPath.split(/[\\/]/)[0];
      return true;
    },
  });

  if (!firstEntry) throw new Error("归档为空");
  return path.join(dest, firstEntry);
}
```

- [ ] **Step 4: 构建并跑测试**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/auth/packager.ts test/auth/packager.test.ts package.json package-lock.json
git commit -m "feat(auth): add tar.gz account packager"
```

> 现在回到 Task 13 完成 CLI 改造。

---

## Task 15：`auth/console-session.ts`（控制台 cookie 登录 + 限流）

**Files:**
- Create: `src/auth/console-session.ts`
- Create: `test/auth/console-session.test.ts`

- [ ] **Step 1: 写测试 `test/auth/console-session.test.ts`**

```typescript
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
```

- [ ] **Step 2: 写 `src/auth/console-session.ts`**

```typescript
import { randomBytes, timingSafeEqual } from "node:crypto";

interface SessionEntry {
  user: string;
  expiresAt: number;
}

export class ConsoleSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  public constructor(private readonly ttlMs: number) {}

  public create(user: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { user, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  public validate(token: string | undefined): SessionEntry | null {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return entry;
  }

  public destroy(token: string): void {
    this.sessions.delete(token);
  }
}

export class RateLimiter {
  private readonly events = new Map<string, number[]>();

  public constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  public recordFailureAndCheck(key: string): boolean {
    const now = Date.now();
    const arr = this.events.get(key) ?? [];
    const filtered = arr.filter((ts) => now - ts < this.windowMs);
    filtered.push(now);
    this.events.set(key, filtered);
    return filtered.length <= this.maxAttempts;
  }
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}
```

- [ ] **Step 3: 跑测试通过**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add src/auth/console-session.ts test/auth/console-session.test.ts
git commit -m "feat(auth): add console session store and rate limiter"
```

---

## Task 16：Console server 骨架（静态文件 + 密码登录 + 鉴权中间件）

**Files:**
- Create: `src/console/server.ts`
- Create: `src/console/static/index.html`
- Create: `src/console/static/login.html`
- Create: `src/console/static/app.js`
- Create: `src/console/static/style.css`
- Create: `test/console/routes.test.ts`
- Modify: `src/api-server.ts`（挂 `/admin/*` 到 `ConsoleServer`）

- [ ] **Step 1: 写 `src/console/server.ts` 基础骨架**

```typescript
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { constantTimeStringEqual, ConsoleSessionStore, RateLimiter } from "../auth/console-session.js";

const STATIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "static");

export interface ConsoleServerOptions {
  password: string;
  username?: string;
  sessionTtlMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

export class ConsoleServer {
  private readonly sessions: ConsoleSessionStore;
  private readonly limiter: RateLimiter;

  public constructor(private readonly options: ConsoleServerOptions) {
    this.sessions = new ConsoleSessionStore(options.sessionTtlMs);
    this.limiter = new RateLimiter(options.rateLimitMax, options.rateLimitWindowMs);
  }

  public async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname.replace(/^\/admin/, "") || "/";

    if (pathname === "/login" && request.method === "GET") {
      return this.serveStatic(response, "login.html");
    }

    if (pathname === "/api/login" && request.method === "POST") {
      return this.handleLogin(request, response);
    }

    if (pathname === "/api/logout" && request.method === "POST") {
      return this.handleLogout(request, response);
    }

    // 鉴权
    const session = this.requireSession(request);
    if (!session) {
      if (pathname === "/" || pathname === "/index.html") {
        response.writeHead(302, { location: "/admin/login" });
        response.end();
        return;
      }
      this.sendJson(response, 401, { error: { message: "Unauthorized" } });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      return this.serveStatic(response, "index.html");
    }
    if (pathname === "/app.js") return this.serveStatic(response, "app.js");
    if (pathname === "/style.css") return this.serveStatic(response, "style.css");
    if (pathname === "/vnc.html") return this.serveStatic(response, "vnc.html");

    this.sendJson(response, 404, { error: { message: "Not found" } });
  }

  private async serveStatic(response: ServerResponse, file: string): Promise<void> {
    const fullPath = path.join(STATIC_ROOT, file);
    try {
      await stat(fullPath);
    } catch {
      this.sendJson(response, 404, { error: { message: "Not found" } });
      return;
    }
    response.writeHead(200, { "content-type": guessContentType(file) });
    createReadStream(fullPath).pipe(response);
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = pickClientIp(request);
    const body = await readJsonBody(request);
    const { username, password } = (body ?? {}) as { username?: string; password?: string };

    const okUser = !this.options.username || (username && constantTimeStringEqual(username, this.options.username));
    const okPass = password && constantTimeStringEqual(password, this.options.password);

    if (!okUser || !okPass) {
      const allowed = this.limiter.recordFailureAndCheck(ip);
      this.sendJson(response, allowed ? 401 : 429, { error: { message: "Invalid credentials" } });
      return;
    }

    const token = this.sessions.create(this.options.username ?? "admin");
    response.setHeader("set-cookie", `a2a_console=${token}; Path=/admin; HttpOnly; SameSite=Lax`);
    this.sendJson(response, 200, { ok: true });
  }

  private handleLogout(request: IncomingMessage, response: ServerResponse): void {
    const token = parseCookie(request.headers.cookie)["a2a_console"];
    if (token) this.sessions.destroy(token);
    response.setHeader("set-cookie", "a2a_console=; Path=/admin; HttpOnly; Max-Age=0");
    this.sendJson(response, 200, { ok: true });
  }

  public requireSession(request: IncomingMessage): { user: string } | null {
    const token = parseCookie(request.headers.cookie)["a2a_console"];
    const entry = this.sessions.validate(token);
    return entry ? { user: entry.user } : null;
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }
}

function guessContentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function parseCookie(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    result[name] = value;
  }
  return result;
}

function pickClientIp(request: IncomingMessage): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0]!.trim();
  return request.socket.remoteAddress ?? "unknown";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

- [ ] **Step 2: 写最小可用静态文件**

`src/console/static/login.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>anything2api admin</title>
<link rel="stylesheet" href="/admin/style.css" />
</head>
<body>
<main class="login">
  <h1>控制台登录</h1>
  <form id="login-form">
    <input type="text" name="username" placeholder="用户名（如开启）" />
    <input type="password" name="password" placeholder="密码" required />
    <button type="submit">登录</button>
    <p id="err"></p>
  </form>
</main>
<script>
document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const response = await fetch("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: form.get("username") || undefined, password: form.get("password") }),
  });
  if (response.ok) {
    location.href = "/admin/";
  } else {
    document.getElementById("err").textContent = "登录失败";
  }
});
</script>
</body>
</html>
```

`src/console/static/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>anything2api</title>
<link rel="stylesheet" href="/admin/style.css" />
</head>
<body>
<header>
  <h1>anything2api 控制台</h1>
  <button id="logout-btn">退出</button>
</header>
<main>
  <section id="accounts-section">
    <div class="row">
      <h2>账号</h2>
      <button id="add-account-btn">添加账号</button>
      <button id="import-btn">导入 tar.gz</button>
      <input type="file" id="import-file" accept=".gz,.tgz" hidden />
    </div>
    <table id="accounts-table">
      <thead>
        <tr>
          <th>Email</th><th>状态</th><th>strikes</th><th>cooldown</th><th>操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </section>
  <section id="usage-section">
    <h2>使用统计</h2>
    <pre id="usage-output">加载中...</pre>
  </section>
</main>
<script src="/admin/app.js"></script>
</body>
</html>
```

`src/console/static/app.js`：

```javascript
const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const init = { method, headers: { "content-type": "application/json" }, credentials: "include" };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`/admin${path}`, init);
  if (!response.ok) throw new Error(`${response.status}`);
  if (response.headers.get("content-type")?.includes("json")) return response.json();
  return response.text();
}

async function refreshAccounts() {
  const accounts = await api("GET", "/api/accounts");
  const tbody = $("#accounts-table tbody");
  tbody.innerHTML = accounts.map((a) => `
    <tr>
      <td>${escapeHtml(a.email)}</td>
      <td>${a.status}</td>
      <td>${a.strikeCount}</td>
      <td>${a.cooldownUntil ?? "—"}</td>
      <td>
        <button data-act="reactivate" data-id="${a.accountId}">激活</button>
        <button data-act="export" data-id="${a.accountId}">导出</button>
        <button data-act="remove" data-id="${a.accountId}">删除</button>
      </td>
    </tr>
  `).join("");
}

async function refreshUsage() {
  const usage = await api("GET", "/api/usage");
  $("#usage-output").textContent = JSON.stringify(usage, null, 2);
}

document.body.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  if (!act || !id) return;
  if (act === "remove" && !confirm("确认删除？")) return;
  if (act === "remove") await api("DELETE", `/api/accounts/${id}`);
  if (act === "reactivate") await api("POST", `/api/accounts/${id}/reactivate`);
  if (act === "export") {
    const link = document.createElement("a");
    link.href = `/admin/api/accounts/${id}/export`;
    link.download = `${id}.tar.gz`;
    link.click();
    return;
  }
  await refreshAccounts();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("POST", "/api/logout");
  location.href = "/admin/login";
});

$("#add-account-btn").addEventListener("click", () => {
  // Task 21 实现
  alert("添加账号功能将在 VNC Task 完成后启用");
});

$("#import-btn").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("archive", file);
  const response = await fetch("/admin/api/accounts/import", {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  if (!response.ok) {
    alert(`导入失败: ${response.status}`);
    return;
  }
  await refreshAccounts();
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

refreshAccounts().then(refreshUsage);
setInterval(() => { refreshAccounts(); refreshUsage(); }, 15_000);
```

`src/console/static/style.css`：

```css
body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7fb; color: #111; }
header { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
main { padding: 24px; display: grid; grid-template-columns: 2fr 1fr; gap: 24px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; text-align: left; }
button { padding: 6px 12px; border: 1px solid #c0c4cc; background: #fff; cursor: pointer; border-radius: 6px; }
button:hover { background: #f3f4f6; }
.login { max-width: 320px; margin: 80px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
.login input { width: 100%; padding: 8px 12px; margin: 4px 0; border: 1px solid #c0c4cc; border-radius: 6px; }
.login button { width: 100%; margin-top: 12px; padding: 8px; background: #2563eb; color: #fff; border: 0; }
pre { background: #fff; padding: 12px; border-radius: 8px; max-height: 320px; overflow: auto; }
```

- [ ] **Step 3: 改 `src/api-server.ts` 挂载 console**

```typescript
import { ConsoleServer } from "./console/server.js";

const CONSOLE_PASSWORD = process.env.WEB_CONSOLE_PASSWORD;
const CONSOLE_USERNAME = process.env.WEB_CONSOLE_USERNAME;
const CONSOLE_SESSION_TTL_HOURS = Number.parseInt(process.env.CONSOLE_SESSION_TTL_HOURS ?? "24", 10);
const RATE_LIMIT_MAX_ATTEMPTS = Number.parseInt(process.env.RATE_LIMIT_MAX_ATTEMPTS ?? "5", 10);
const RATE_LIMIT_WINDOW_MINUTES = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES ?? "15", 10);

const consoleServer = CONSOLE_PASSWORD
  ? new ConsoleServer({
      password: CONSOLE_PASSWORD,
      username: CONSOLE_USERNAME,
      sessionTtlMs: CONSOLE_SESSION_TTL_HOURS * 3600_000,
      rateLimitMax: RATE_LIMIT_MAX_ATTEMPTS,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MINUTES * 60_000,
    })
  : null;
```

`routeRequest` 中：

```typescript
if (url.pathname.startsWith("/admin/")) {
  if (!consoleServer) {
    sendJson(response, 503, { error: { message: "console disabled (WEB_CONSOLE_PASSWORD not set)" } });
    return;
  }
  await consoleServer.handle(request, response, url);
  return;
}
```

- [ ] **Step 4: 写 `test/console/routes.test.ts` 基础测试**

```typescript
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import test from "node:test";

import { ConsoleServer } from "../../src/console/server.js";

function makeReqRes(method: string, headers: Record<string, string> = {}): { req: IncomingMessage; res: ServerResponse; collected: { status?: number; body?: string; headers?: Record<string, string> } } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.headers = headers;
  const collected: { status?: number; body?: string; headers?: Record<string, string> } = { headers: {} };
  const res = new ServerResponse(req);
  // override writeHead / end
  res.writeHead = ((status: number, h?: any) => { collected.status = status; if (h) Object.assign(collected.headers!, h); return res; }) as any;
  res.end = ((body?: any) => { collected.body = typeof body === "string" ? body : ""; return res; }) as any;
  res.setHeader = ((name: string, value: any) => { collected.headers![name.toLowerCase()] = String(value); }) as any;
  return { req, res, collected };
}

test("ConsoleServer rejects wrong password", async () => {
  const server = new ConsoleServer({
    password: "secret",
    sessionTtlMs: 60_000,
    rateLimitMax: 5,
    rateLimitWindowMs: 60_000,
  });
  const { req, res, collected } = makeReqRes("POST");
  // mock body
  (req as any)[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ password: "wrong" }));
  };
  await server.handle(req, res, new URL("http://x/admin/api/login"));
  assert.equal(collected.status, 401);
});

test("ConsoleServer accepts right password and sets cookie", async () => {
  const server = new ConsoleServer({
    password: "secret",
    sessionTtlMs: 60_000,
    rateLimitMax: 5,
    rateLimitWindowMs: 60_000,
  });
  const { req, res, collected } = makeReqRes("POST");
  (req as any)[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ password: "secret" }));
  };
  await server.handle(req, res, new URL("http://x/admin/api/login"));
  assert.equal(collected.status, 200);
  assert.match(collected.headers!["set-cookie"], /a2a_console=/);
});
```

- [ ] **Step 5: 构建并跑测试**

```bash
# 把静态资源拷到 dist：tsconfig 不会复制 .html/.css/.js，需要小补丁
```

修改 `tsconfig.json` 加 `"resolveJsonModule": true`，不够；TS 不会拷非 ts 文件。最简办法是在 `package.json` 的 `build` 脚本里加拷贝：

```json
"build": "tsc -p tsconfig.json && node -e \"require('fs').cpSync('src/console/static','dist/src/console/static',{recursive:true})\""
```

跑：

```bash
npm test
```

- [ ] **Step 6: 手动验证**

```bash
API_KEYS=test WEB_CONSOLE_PASSWORD=hunter2 npm run serve &
sleep 2
curl -i http://127.0.0.1:8787/admin/login
curl -i -X POST -H "Content-Type: application/json" -d '{"password":"hunter2"}' http://127.0.0.1:8787/admin/api/login
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(console): add admin console scaffolding with password login"
```

---

## Task 17：Console 账号 REST API

**Files:**
- Modify: `src/console/server.ts`（加 `/admin/api/accounts*` 路由）
- Modify: `src/api-server.ts`（把 `AccountPool` + `UsageTracker` 注入 `ConsoleServer`）

- [ ] **Step 1: 改 `ConsoleServer` 构造，注入 backend 句柄**

```typescript
export interface ConsoleServerDeps {
  pool: AccountPool;
  usage: UsageTracker | null;
  importArchive(stream: NodeJS.ReadableStream): Promise<AccountSessionRecord>;
  exportAccount(accountId: string): Promise<{ archivePath: string; cleanup: () => Promise<void> }>;
}

constructor(
  private readonly options: ConsoleServerOptions,
  private readonly deps: ConsoleServerDeps,
) { ... }
```

- [ ] **Step 2: 在 `ConsoleServer.handle` 鉴权通过后加路由分发**

```typescript
if (pathname === "/api/accounts" && request.method === "GET") {
  const accounts = await this.deps.pool.listAccounts();
  this.sendJson(response, 200, accounts);
  return;
}

const accountIdMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
if (accountIdMatch && request.method === "DELETE") {
  await this.deps.pool.removeAccount(accountIdMatch[1]!);
  this.sendJson(response, 200, { ok: true });
  return;
}

const reactivateMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/reactivate$/);
if (reactivateMatch && request.method === "POST") {
  const result = await this.deps.pool.reactivateAccount(reactivateMatch[1]!);
  this.sendJson(response, 200, result);
  return;
}

const exportMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/export$/);
if (exportMatch && request.method === "GET") {
  const { archivePath, cleanup } = await this.deps.exportAccount(exportMatch[1]!);
  response.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${exportMatch[1]}.tar.gz"`,
  });
  const stream = createReadStream(archivePath);
  stream.pipe(response);
  stream.on("end", () => void cleanup());
  return;
}

if (pathname === "/api/accounts/import" && request.method === "POST") {
  // multipart 的解析省心做法：用 busboy；这里手工做最简版
  const session = await this.deps.importArchive(request);
  this.sendJson(response, 200, session);
  return;
}

if (pathname === "/api/usage" && request.method === "GET") {
  const usage = this.deps.usage ? await this.deps.usage.aggregate() : { totalRequests: 0 };
  this.sendJson(response, 200, usage);
  return;
}
```

- [ ] **Step 3: 在 `api-server.ts` 实现注入**

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";

import { packAccount, unpackAccount } from "./auth/packager.js";

// 装载 backend 后
const backend = new AnythingProxyBackend(log);

const consoleServer = CONSOLE_PASSWORD
  ? new ConsoleServer(
      {
        password: CONSOLE_PASSWORD,
        username: CONSOLE_USERNAME,
        sessionTtlMs: CONSOLE_SESSION_TTL_HOURS * 3600_000,
        rateLimitMax: RATE_LIMIT_MAX_ATTEMPTS,
        rateLimitWindowMs: RATE_LIMIT_WINDOW_MINUTES * 60_000,
      },
      {
        pool: backend.pool,
        usage: backend.usage,
        importArchive: async (stream) => {
          // 简化：先把整个请求体落到临时 .tar.gz，再 unpack
          const tmpFile = path.join(os.tmpdir(), `import-${Date.now()}.tar.gz`);
          await pipeStreamToFile(stream, tmpFile);
          const dir = await unpackAccount(tmpFile);
          const session = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8"));
          await backend.pool.addPreparedSession(session);
          await rm(tmpFile, { force: true });
          return session;
        },
        exportAccount: async (accountId) => {
          const accounts = await backend.pool.listAccounts();
          const account = accounts.find((a) => a.accountId === accountId);
          if (!account) throw new Error("not found");
          const tmpDir = await mkdtemp(path.join(os.tmpdir(), "export-"));
          const archive = path.join(tmpDir, `${accountId}.tar.gz`);
          await packAccount(account.accountDir, archive);
          return { archivePath: archive, cleanup: async () => rm(tmpDir, { recursive: true, force: true }) };
        },
      },
    )
  : null;
```

`AnythingProxyBackend.pool` / `.usage` 需要把 `private readonly` 改成 `public readonly`。

> 注意：上面的 `importArchive` 假设 `request` body 直接就是 tar.gz 二进制流。这意味着前端 `app.js` 不能用 `FormData`，而是改成：
> ```js
> const response = await fetch("/admin/api/accounts/import", {
>   method: "POST",
>   headers: { "content-type": "application/gzip" },
>   body: file,
> });
> ```
> 同步更新 `app.js`。

- [ ] **Step 4: 加 helper**

```typescript
async function pipeStreamToFile(input: NodeJS.ReadableStream, target: string): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(target);
    input.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    input.on("error", reject);
  });
}
```

- [ ] **Step 5: 手动验证 + commit**

```bash
API_KEYS=test WEB_CONSOLE_PASSWORD=hunter2 npm run serve &
sleep 2
# 登录后拿 cookie 文件
curl -c cookies.txt -X POST -H "Content-Type: application/json" -d '{"password":"hunter2"}' http://127.0.0.1:8787/admin/api/login
curl -b cookies.txt http://127.0.0.1:8787/admin/api/accounts        # 期望 []
kill %1
```

```bash
git add -A
git commit -m "feat(console): expose accounts REST API with packager"
```

---

## Task 18：`vnc/supervisor.ts` (Xvfb + x11vnc + websockify 编排)

**Files:**
- Create: `src/vnc/supervisor.ts`
- Create: `test/vnc/supervisor.test.ts`

- [ ] **Step 1: 写 `test/vnc/supervisor.test.ts`（mock spawn）**

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { VncSupervisor } from "../../src/vnc/supervisor.js";

class FakeProcess {
  public killed = false;
  public on(_event: string, _cb: (...args: unknown[]) => void): this { return this; }
  public kill(): void { this.killed = true; }
}

test("VncSupervisor refuses concurrent start", async () => {
  const supervisor = new VncSupervisor({
    display: ":99",
    vncPort: 5900,
    wsPort: 6080,
    spawn: () => new FakeProcess() as unknown as any,
    sleep: async () => {},
  });

  const s1 = await supervisor.start();
  await assert.rejects(() => supervisor.start(), /already running/);
  await supervisor.stop(s1.sessionId);
});

test("VncSupervisor cleans up children on stop", async () => {
  const procs: FakeProcess[] = [];
  const supervisor = new VncSupervisor({
    display: ":99",
    vncPort: 5900,
    wsPort: 6080,
    spawn: () => {
      const p = new FakeProcess();
      procs.push(p);
      return p as unknown as any;
    },
    sleep: async () => {},
  });

  const session = await supervisor.start();
  await supervisor.stop(session.sessionId);
  assert.ok(procs.every((p) => p.killed));
});
```

- [ ] **Step 2: 写 `src/vnc/supervisor.ts`**

```typescript
import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface VncSupervisorOptions {
  display?: string;
  vncPort?: number;
  wsPort?: number;
  spawn?: typeof nativeSpawn;
  sleep?: (ms: number) => Promise<void>;
}

export interface VncSessionHandle {
  sessionId: string;
  display: string;
  wsPort: number;
}

export class VncSupervisor {
  private active: { sessionId: string; processes: ChildProcess[] } | null = null;

  public constructor(private readonly options: VncSupervisorOptions = {}) {}

  public async start(): Promise<VncSessionHandle> {
    if (this.active) throw new Error("VNC already running");

    const display = this.options.display ?? ":99";
    const vncPort = this.options.vncPort ?? 5900;
    const wsPort = this.options.wsPort ?? 6080;
    const spawnImpl = this.options.spawn ?? nativeSpawn;
    const sleep = this.options.sleep ?? defaultSleep;

    const xvfb = spawnImpl("Xvfb", [display, "-screen", "0", "1280x800x24"], { stdio: "ignore" });
    await sleep(500);
    const x11vnc = spawnImpl(
      "x11vnc",
      ["-display", display, "-nopw", "-forever", "-shared", "-rfbport", String(vncPort), "-quiet"],
      { stdio: "ignore" },
    );
    await sleep(500);
    const websockify = spawnImpl(
      "websockify",
      [String(wsPort), `127.0.0.1:${vncPort}`, "--web", process.env.NOVNC_DIR ?? "/usr/share/novnc"],
      { stdio: "ignore" },
    );
    await sleep(500);

    const sessionId = randomBytes(16).toString("hex");
    this.active = { sessionId, processes: [xvfb, x11vnc, websockify] };

    return { sessionId, display, wsPort };
  }

  public getStatus(): { running: boolean; sessionId?: string } {
    if (!this.active) return { running: false };
    return { running: true, sessionId: this.active.sessionId };
  }

  public async stop(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    for (const proc of this.active.processes) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.active = null;
  }

  public async stopAny(): Promise<void> {
    if (this.active) await this.stop(this.active.sessionId);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 3: 跑测试 + commit**

```bash
npm test
git add src/vnc test/vnc
git commit -m "feat(vnc): supervisor for Xvfb + x11vnc + websockify"
```

---

## Task 19：Console `/admin/api/login/*` 编排 + WebSocket 反代

**Files:**
- Modify: `src/console/server.ts`（加 login 路由 + WebSocket 反代）
- Modify: `src/api-server.ts`（接 VncSupervisor 与 loginInteractive）
- Modify: `src/console/static/index.html`、`app.js`（加号按钮真正打开 vnc.html）
- Create: `src/console/static/vnc.html`
- Add deps: `ws`

- [ ] **Step 1: 加依赖**

```bash
npm install ws
npm install --save-dev @types/ws
```

- [ ] **Step 2: 改 `ConsoleServer` 添加登录会话状态**

```typescript
export interface ConsoleServerDeps {
  pool: AccountPool;
  usage: UsageTracker | null;
  importArchive(stream: NodeJS.ReadableStream): Promise<AccountSessionRecord>;
  exportAccount(accountId: string): Promise<{ archivePath: string; cleanup: () => Promise<void> }>;
  vnc: VncSupervisor;
  loginInteractive(args: {
    display: string;
    log: (m: string) => void;
    signal: AbortSignal;
  }): Promise<AccountSessionRecord>;
}

private loginState: {
  vncSessionId: string;
  status: "provisioning" | "waiting" | "detecting" | "done" | "failed" | "cancelled";
  controller: AbortController;
  error?: string;
  session?: AccountSessionRecord;
  startedAt: number;
} | null = null;
```

加路由：

```typescript
if (pathname === "/api/login/start" && request.method === "POST") {
  if (this.loginState && ["provisioning","waiting","detecting"].includes(this.loginState.status)) {
    this.sendJson(response, 409, { error: { message: "login already in progress" } });
    return;
  }
  const vnc = await this.deps.vnc.start();
  this.loginState = {
    vncSessionId: vnc.sessionId,
    status: "provisioning",
    controller: new AbortController(),
    startedAt: Date.now(),
  };
  void (async () => {
    try {
      this.loginState!.status = "waiting";
      const session = await this.deps.loginInteractive({
        display: vnc.display,
        log: (m) => console.log(m),
        signal: this.loginState!.controller.signal,
      });
      this.loginState!.status = "done";
      this.loginState!.session = session;
      await this.deps.pool.addPreparedSession(session);
    } catch (error) {
      this.loginState!.status = "failed";
      this.loginState!.error = (error as Error).message;
    } finally {
      await this.deps.vnc.stopAny();
    }
  })();
  this.sendJson(response, 200, { sessionId: vnc.sessionId, vncWsUrl: `/admin/vnc/${vnc.sessionId}` });
  return;
}

if (pathname === "/api/login/status" && request.method === "GET") {
  this.sendJson(response, 200, this.loginState ?? { status: "idle" });
  return;
}

if (pathname === "/api/login/cancel" && request.method === "POST") {
  if (this.loginState) {
    this.loginState.controller.abort();
    this.loginState.status = "cancelled";
    await this.deps.vnc.stopAny();
  }
  this.sendJson(response, 200, { ok: true });
  return;
}
```

- [ ] **Step 3: WebSocket 反代到 websockify**

由于 `node:http` server 接管 upgrade 事件，我们在 `startApiServer` 里加：

```typescript
import { WebSocketServer, WebSocket } from "ws";

const wsServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (!url.pathname.startsWith("/admin/vnc/")) {
    socket.destroy();
    return;
  }
  // 校验 console session cookie
  const sessionToken = parseCookieHeader(request.headers.cookie)["a2a_console"];
  if (!consoleServer || !consoleServer.requireSessionByToken(sessionToken)) {
    socket.destroy();
    return;
  }
  // 校验 sessionId 匹配
  const sessionId = url.pathname.split("/").pop();
  const loginStatus = consoleServer.getLoginStatus();
  if (loginStatus?.vncSessionId !== sessionId) {
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (clientWs) => {
    const upstreamWs = new WebSocket("ws://127.0.0.1:6080/websockify");
    bridgeWebSockets(clientWs, upstreamWs);
  });
});

function bridgeWebSockets(a: WebSocket, b: WebSocket): void {
  a.on("message", (data) => b.readyState === WebSocket.OPEN && b.send(data));
  b.on("message", (data) => a.readyState === WebSocket.OPEN && a.send(data));
  a.on("close", () => b.close());
  b.on("close", () => a.close());
  a.on("error", () => b.close());
  b.on("error", () => a.close());
}

function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    result[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return result;
}
```

在 `src/console/server.ts` 的 `ConsoleServer` 里加这两个 public 方法：

```typescript
public requireSessionByToken(token: string | undefined): { user: string } | null {
  return this.sessions.validate(token);
}

public getLoginStatus(): { vncSessionId: string; status: string } | null {
  return this.loginState
    ? { vncSessionId: this.loginState.vncSessionId, status: this.loginState.status }
    : null;
}
```

- [ ] **Step 4: 写 `src/console/static/vnc.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>VNC 登录</title>
<style>body, html { margin: 0; height: 100%; overflow: hidden; } #screen { width: 100%; height: 100%; }</style>
</head>
<body>
<div id="screen"></div>
<script type="module">
import RFB from "/admin/novnc/core/rfb.js";

const params = new URLSearchParams(location.search);
const sessionId = params.get("session");
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProto}://${location.host}/admin/vnc/${sessionId}`;
const rfb = new RFB(document.getElementById("screen"), wsUrl);
rfb.viewOnly = false;
rfb.scaleViewport = true;

setInterval(async () => {
  const status = await (await fetch("/admin/api/login/status")).json();
  if (status.status === "done") {
    alert("登录完成: " + status.session.email);
    location.href = "/admin/";
  } else if (status.status === "failed" || status.status === "cancelled") {
    alert("登录失败: " + (status.error || status.status));
    location.href = "/admin/";
  }
}, 3000);
</script>
</body>
</html>
```

> 注意：noVNC 资源 `/admin/novnc/*` 由 `ConsoleServer` 反代到 `/usr/share/novnc/`。在 `ConsoleServer.handle` 加：
> ```typescript
> if (pathname.startsWith("/novnc/")) {
>   const sub = pathname.slice("/novnc/".length);
>   const novncRoot = process.env.NOVNC_DIR ?? "/usr/share/novnc";
>   const file = path.join(novncRoot, sub);
>   try {
>     await stat(file);
>     response.writeHead(200, { "content-type": guessContentType(file) });
>     createReadStream(file).pipe(response);
>   } catch {
>     this.sendJson(response, 404, { error: { message: "novnc asset not found" } });
>   }
>   return;
> }
> ```

- [ ] **Step 5: 改 `app.js` 加号按钮真接登录**

```javascript
$("#add-account-btn").addEventListener("click", async () => {
  const data = await api("POST", "/api/login/start");
  const url = `/admin/vnc.html?session=${data.sessionId}`;
  window.open(url, "_blank", "width=1320,height=900");
});
```

- [ ] **Step 6: 接入 vnc + loginInteractive 到 backend**

`api-server.ts` 中创建 `ConsoleServer` 时多传：

```typescript
{
  ...
  vnc: new VncSupervisor(),
  loginInteractive: async ({ display, log, signal }) => {
    return await loginInteractive({ display, log, signal, headless: false });
  },
}
```

- [ ] **Step 7: 构建并 commit**

```bash
npm run build
git add -A
git commit -m "feat(console): wire VNC login flow with websocket bridge"
```

---

## Task 20：Dockerfile + docker-compose + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: 写 `.dockerignore`**

```
node_modules
dist
data
.git
*.log
docs
test
```

- [ ] **Step 2: 写 `Dockerfile`**

```dockerfile
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk fonts-noto-color-emoji \
      xvfb x11vnc fluxbox \
      novnc websockify python3 \
      ca-certificates dumb-init procps \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NOVNC_DIR=/usr/share/novnc \
    NODE_ENV=production \
    PORT=7860 \
    HEADLESS=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@5 \
 && npx tsc -p tsconfig.json \
 && node -e "require('fs').cpSync('src/console/static','dist/src/console/static',{recursive:true})" \
 && rm -rf src node_modules/typescript

RUN useradd -m -s /bin/bash app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

VOLUME ["/app/data"]
EXPOSE 7860
ENTRYPOINT ["dumb-init","--"]
CMD ["node","dist/src/cli.js","serve"]
```

- [ ] **Step 3: 写 `docker-compose.yml`**

```yaml
services:
  anything2api:
    build: .
    image: anything2api:latest
    container_name: anything2api
    ports:
      - "127.0.0.1:7860:7860"
    restart: unless-stopped
    environment:
      PORT: "7860"
      API_KEYS: "change-me"
      WEB_CONSOLE_PASSWORD: "change-me-too"
      STREAMING_MODE: "real"
      ACCOUNT_COOLDOWN_HOURS: "12"
      FAILURE_THRESHOLD: "3"
      IMMEDIATE_SWITCH_STATUS_CODES: "429,403,401"
      TZ: "Asia/Shanghai"
    volumes:
      - ./data:/app/data
```

- [ ] **Step 4: 本地 build + 跑 + smoke**

```bash
docker compose build
docker compose up -d
sleep 5
curl -i http://127.0.0.1:7860/healthz
curl -i http://127.0.0.1:7860/admin/login
docker compose down
```

预期：`/healthz` 200，`/admin/login` 200 + login.html。

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "build: add Docker image with chromium + xvfb + novnc"
```

---

## Task 21：文档（README + deploy-zeabur + admin-console）

**Files:**
- Create: `docs/deploy-zeabur.md`
- Create: `docs/admin-console.md`
- Modify: `README.md`（彻底重写）

- [ ] **Step 1: 写 `docs/deploy-zeabur.md`**

```markdown
# 部署到 Zeabur

## 前置条件
- Zeabur 账号（注意 2026-03-15 起共享集群停止接新项目，需要付费集群）
- 至少能在本地或服务器上跑一次登录（云上无图形界面则用容器内 noVNC）

## 步骤

1. 把仓库推到 Git 服务（GitHub / GitLab）。
2. Zeabur Project → Add Service → Git Source → 选本仓库。
3. Service Settings → Variables：
   - `API_KEYS=<你的 key>`
   - `WEB_CONSOLE_PASSWORD=<强密码>`
   - `STREAMING_MODE=fake`（强烈推荐，Cloudflare/Tunnel 长连接友好）
   - `TZ=Asia/Shanghai`
4. Service Settings → Storage → Add Volume，挂到 `/app/data`，至少 1 GB。
5. Networking → Expose Port 7860 → 生成域名。
6. Build → Use Dockerfile（自动检测）。
7. 部署完成后访问 `https://<your-zeabur-domain>/admin/login`，输入 WEB_CONSOLE_PASSWORD。
8. 点「添加账号」→ 在弹出的 noVNC 页面里完成 Google 登录。
9. 账号添加成功后 `/v1/*` 即可使用。
```

- [ ] **Step 2: 写 `docs/admin-console.md`**

```markdown
# 控制台使用

## 登录
访问 `/admin/login`，输入 `WEB_CONSOLE_PASSWORD`（如配置了 `WEB_CONSOLE_USERNAME` 则同时输用户名）。

## 账号管理
- **添加账号**：点「添加账号」按钮，会弹出新窗口加载 noVNC，在容器内 Chromium 里用 Google 登录 anything.com。登录成功后自动落盘并加入账号池。
- **导入账号**：点「导入 tar.gz」上传从其他实例 export 出来的账号包。
- **导出账号**：表格里点「导出」下载 tar.gz。
- **重新激活**：账号被标记为 cooldown / deleted 后，可手动激活回 active。
- **删除**：从池子里移除（不删 disk，重新导入即可恢复）。

## 使用统计
右侧栏展示当前 `data/usage-stats.jsonl` 的聚合（按模型 / 按账号）。每 15 秒自动刷新。
```

- [ ] **Step 3: 重写 `README.md` 为下面的完整内容**

````markdown
# anything-2api

把 `anything.com` 包装成兼容 OpenAI / Anthropic 的本地/远程 2api 代理。**自带 Google 账号**版本（不再批量注册）。

## 功能

- OpenAI 兼容：`/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/models`
- Anthropic 兼容：`/v1/messages`
- API_KEYS 鉴权
- 真流式 + 假流式可切换（Cloudflare Worker 长连接友好）
- 多账号池 + LRU 轮询 + 失败 cooldown + 主动轮转
- 自动清洗站内 reasoning UI 块
- best-effort `tool_calls` / `tool_use`
- Web 控制台 + 容器内 noVNC 登录账号（直接在浏览器里完成 Google 登录）
- usage-stats.jsonl 持久化
- Prometheus `/metrics`
- Cloudflare Worker 反代（隐藏源站 IP）

## 快速开始（Docker）

```bash
cp docker-compose.yml my.yml
# 改 API_KEYS / WEB_CONSOLE_PASSWORD
docker compose -f my.yml up -d
```

打开 `http://127.0.0.1:7860/admin/login` → 输入 `WEB_CONSOLE_PASSWORD` → 点「添加账号」→ 在弹出的 noVNC 页面里完成 Google 登录。

之后客户端就可以用：

```bash
curl -X POST http://127.0.0.1:7860/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"你好"}]}'
```

## 快速开始（本地开发，需要图形界面）

```bash
npm install
npm run build
HEADLESS=false API_KEYS=dev WEB_CONSOLE_PASSWORD=dev npm run login   # 弹出 Chromium 让你登录
API_KEYS=dev WEB_CONSOLE_PASSWORD=dev npm run serve
```

## 控制台

详见 [docs/admin-console.md](docs/admin-console.md)。

## API 鉴权

`/v1/*` 必须带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`，key 与 `API_KEYS` 环境变量逗号分隔列表匹配即可。未设 `API_KEYS` 启动直接退出。

## 环境变量参考

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `7860` | HTTP 端口 |
| `API_KEYS` | 必填 | 逗号分隔的可用 key 列表 |
| `WEB_CONSOLE_PASSWORD` | 可选 | 未设则禁用控制台 |
| `WEB_CONSOLE_USERNAME` | 可选 | 设了就要双因子 |
| `METRICS_TOKEN` | 可选 | 设了 `/metrics` 也要鉴权 |
| `CONSOLE_SESSION_TTL_HOURS` | `24` | 控制台 cookie 有效期 |
| `RATE_LIMIT_MAX_ATTEMPTS` | `5` | 控制台登录失败次数 |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | 失败窗口 |
| `HEADLESS` | `true` | 服务运行时 puppeteer 模式 |
| `DATA_DIR` | `data` | 数据目录 |
| `MAX_POOL_SIZE` | `32` | 账号上限 |
| `ACCOUNT_COOLDOWN_HOURS` | `12` | cooldown 时长 |
| `FAILURE_THRESHOLD` | `3` | 连续失败到此进入 deleted |
| `ACCOUNT_MAX_STRIKES` | 同义于 `FAILURE_THRESHOLD` | 向后兼容 |
| `IMMEDIATE_SWITCH_STATUS_CODES` | `429,403,401` | 立即 cooldown 的 HTTP 状态 |
| `SWITCH_ON_USES` | `40` | 单号被连续使用上限，到了主动轮转 |
| `MAX_FAILOVER_ATTEMPTS` | `4` | 单次请求允许切几次号 |
| `STREAMING_MODE` | `real` | `real` / `fake` |
| `STREAM_TIMEOUT_MS` | `60000` | 真流式 chunk 间最大间隔 |
| `FAKE_STREAM_TIMEOUT_MS` | `300000` | 假流式整体超时 |
| `VNC_LOGIN_TIMEOUT_MS` | `600000` | noVNC 登录会话超时 |
| `ENABLE_USAGE_STATS` | `true` | 是否写 usage-stats.jsonl |
| `USAGE_MAX_BYTES` | `52428800` | usage-stats rotate 阈值（50MB） |
| `ANYTHING_BASE_URL` | `https://www.anything.com` | 上游 |
| `TZ` | 系统时区 | |
| `NOVNC_DIR` | `/usr/share/novnc` | noVNC 静态资源路径 |

## 部署方案矩阵

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 本地电脑 | ✅ | 直接 `npm run serve`，本机能 Google 登录 |
| VPS / 云服务器 | ✅ 推荐 | 用 Docker；或本机登录后上传 `data/` 到 VPS |
| Docker（Render/Fly.io/Railway/Zeabur） | ✅ | 通过容器内 noVNC 登录 |
| Cloudflare Workers | ❌ | 无 Node、无浏览器，不能跑主服务；但 worker/anything2api 仍可做反代 |

详细 Zeabur 部署见 [docs/deploy-zeabur.md](docs/deploy-zeabur.md)。

## Cloudflare Worker 反代

仓库内 `worker/anything2api` 是现成反代工程：

```bash
cd worker/anything2api
# 把 wrangler.jsonc 里 UPSTREAM_BASE_URL 改成你的源站
wrangler deploy
```

特点：
- 普通请求直接反代
- `stream=true` 走 Durable Object 分片
- 可选 `WORKER_AUTH_TOKEN` 二次鉴权

## Metrics / Prometheus / Grafana

`GET /metrics` 暴露 Prometheus 文本格式，包含：

- `anything2api_http_requests_total`
- `anything2api_generation_requests_total`
- `anything2api_generation_failovers_total`
- `anything2api_tool_calls_total`
- `anything2api_pool_active_accounts` / `cooldown` / `deleted` / `busy`
- 等等

Prometheus / Grafana 部署文件在 `deploy/` 目录。

## CLI

- `npm run serve`：启动 2api
- `npm run login`：本地图形界面登录（要求 `HEADLESS=false`）
- `npm run accounts:list`：列出账号
- `npm run accounts:remove -- <accountId>`：删账号
- `npm run accounts:reactivate -- <accountId>`：把账号从 cooldown / deleted 拉回 active
- `npm run accounts:export -- <accountId> <out.tar.gz>`：导出账号包
- `npm run accounts:import -- <archive.tar.gz>`：导入账号包

## 测试

```bash
npm test
```

## 升级到 BYO Account 版本

如果你从批量注册版本升级：

1. 现有 `data/accounts/<id>/` 与 `data/account-pool.json` 保留可用。
2. 旧的 `registered_emails.txt` / `registered_results.jsonl` 不再被读，可以删掉。
3. `npm run register` / `npm run pool:fill` 已废弃，启动时不会再自动注册。
4. 必须设置 `API_KEYS` 与 `WEB_CONSOLE_PASSWORD` 才能启动。
````


- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: rewrite README and add deployment guides"
```

---

## Task 22：端到端 smoke 测试 + 收尾

**Files:**
- Touch: 无新文件

- [ ] **Step 1: 完整本地 docker 流程**

```bash
docker compose build
docker compose up -d
sleep 5
```

- [ ] **Step 2: 验证各端点**

```bash
# 健康
curl -s http://127.0.0.1:7860/healthz | jq .

# /v1/models 没 key 应 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7860/v1/models  # 期望 401

# 带 key 应 200
curl -s -H "Authorization: Bearer change-me" http://127.0.0.1:7860/v1/models | jq .data | head

# 控制台登录
curl -c c.txt -X POST -H "Content-Type: application/json" -d '{"password":"change-me-too"}' http://127.0.0.1:7860/admin/api/login
curl -b c.txt http://127.0.0.1:7860/admin/api/accounts  # 期望 []
```

- [ ] **Step 3: 在浏览器跑 noVNC 登录**

打开 `http://127.0.0.1:7860/admin/login`，登录控制台 → 点「添加账号」→ 在弹窗里完成 Google 登录。

预期：完成后控制台账号表格出现该账号，状态 active。

- [ ] **Step 4: 跑一次 chat completion**

```bash
curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer change-me" \
  -d '{"model":"anything-auto","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:7860/v1/chat/completions | jq .
```

预期：返回 200 + assistant 文本。

- [ ] **Step 5: 看 usage 与 metrics**

```bash
curl -b c.txt http://127.0.0.1:7860/admin/api/usage | jq .   # 1 条以上
curl -s http://127.0.0.1:7860/metrics | head -50            # Prometheus 文本
```

- [ ] **Step 6: 关闭容器并打 tag**

```bash
docker compose down
git tag v2.0.0-byo-account
```

- [ ] **Step 7: Commit "ship" 标记**

如果中间还有未提交的零碎修改：

```bash
git add -A && git commit -m "chore: end-to-end smoke pass"
```

---

## 后续可选扩展（不在本计划中实施）

- noVNC 二维码登录页（移动端友好）
- usage-stats 增加按日期 range 过滤
- 自动定期 ping `Me()` 健康检查刷新 token（替代纯被动续期）
- GHCR 自动构建 (.github/workflows/docker.yml)
- Firefox + Camoufox 作为 Chromium 风控失效时的备选浏览器
