import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AccountSessionRecord } from "./account.js";
import type { StoredCookie } from "./cookies.js";
import { formatError } from "./util/error.js";
import { formatLocalTimestamp } from "./util/time.js";

export type PoolAccountStatus = "active" | "cooldown" | "deleted";

export interface PoolAccountRecord extends AccountSessionRecord {
  status: PoolAccountStatus;
  strikeCount: number;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  consecutiveUses: number;
}

export interface AccountPoolState {
  version: number;
  desiredSize: number;
  updatedAt: string;
  accounts: PoolAccountRecord[];
}

export interface AccountPoolSummary {
  desiredSize: number;
  total: number;
  active: number;
  cooldown: number;
  deleted: number;
  nonDeleted: number;
}

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
const POOL_STATE_PATH = path.join(DATA_DIR, "account-pool.json");
const MAX_POOL_SIZE = parsePositiveInteger(process.env.MAX_POOL_SIZE, 1024);
const ACCOUNT_COOLDOWN_HOURS = parsePositiveInteger(process.env.ACCOUNT_COOLDOWN_HOURS, 12);
const ACCOUNT_MAX_STRIKES = parsePositiveInteger(process.env.ACCOUNT_MAX_STRIKES ?? process.env.FAILURE_THRESHOLD, 2);
const SWITCH_ON_USES = parsePositiveInteger(process.env.SWITCH_ON_USES, 40);

export class AccountPool {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly log: (message: string) => void = console.log,
  ) {}

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
      selected.consecutiveUses = (selected.consecutiveUses ?? 0) + 1;
      selected.lastUsedAt = formatLocalTimestamp(new Date());
      state.updatedAt = formatLocalTimestamp(new Date());
      await this.saveState(state);
      return selected;
    });
  }

  public async markSuccess(accountId: string): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.loadState();
      const account = state.accounts.find((item) => item.accountId === accountId);
      if (!account) {
        return;
      }

      account.lastError = null;
      account.lastUsedAt = formatLocalTimestamp(new Date());
      if (account.status !== "deleted") {
        account.status = "active";
        account.cooldownUntil = null;
      }
      if (SWITCH_ON_USES > 0 && (account.consecutiveUses ?? 0) >= SWITCH_ON_USES) {
        account.consecutiveUses = 0;
      }
      state.updatedAt = formatLocalTimestamp(new Date());
      await this.saveState(state);
    });
  }

  public async markFailure(accountId: string, error: unknown): Promise<PoolAccountRecord | null> {
    return this.runExclusive(async () => {
      const state = await this.loadState();
      const account = state.accounts.find((item) => item.accountId === accountId);
      if (!account) {
        return null;
      }

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
      account.consecutiveUses = 0;
      account.cooldownUntil = null;
      account.lastError = null;
      state.updatedAt = formatLocalTimestamp(new Date());
      await this.saveState(state);
      return account;
    });
  }

  public async updateSessionCookies(accountId: string, cookies: StoredCookie[]): Promise<void> {
    await this.runExclusive(async () => {
      const state = await this.loadState();
      const account = state.accounts.find((item) => item.accountId === accountId);
      if (!account) {
        return;
      }

      account.cookies = cookies;
      state.updatedAt = formatLocalTimestamp(new Date());
      await this.saveState(state);
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

  public async listAccounts(): Promise<PoolAccountRecord[]> {
    const state = await this.loadState();
    this.reactivateExpiredCooldowns(state);
    await this.saveState(state);
    return state.accounts;
  }

  public async getSummary(): Promise<AccountPoolSummary> {
    const state = await this.loadState();
    this.reactivateExpiredCooldowns(state);
    await this.saveState(state);
    return summarizeState(state);
  }

  public async addPreparedSession(session: AccountSessionRecord): Promise<PoolAccountRecord | null> {
    return this.runExclusive(async () => {
      const state = await this.loadState();
      this.reactivateExpiredCooldowns(state);

      const existing = state.accounts.find((account) => account.accountId === session.accountId);
      if (existing) {
        const status = existing.status;
        const strikeCount = existing.strikeCount;
        const cooldownUntil = existing.cooldownUntil;
        const lastUsedAt = existing.lastUsedAt;
        const consecutiveUses = existing.consecutiveUses ?? 0;
        Object.assign(existing, session);
        if (existing.status !== "deleted") {
          existing.status = "active";
          existing.cooldownUntil = null;
        } else {
          existing.status = status;
          existing.cooldownUntil = cooldownUntil;
        }
        existing.strikeCount = strikeCount;
        existing.lastError = null;
        existing.lastUsedAt = lastUsedAt;
        existing.consecutiveUses = consecutiveUses;
        state.updatedAt = formatLocalTimestamp(new Date());
        await this.saveState(state);
        return existing;
      }

      if (countNonDeletedAccounts(state) >= MAX_POOL_SIZE) {
        compactState(state);
        state.updatedAt = formatLocalTimestamp(new Date());
        await this.saveState(state);
        return null;
      }

      const record: PoolAccountRecord = {
        ...session,
        status: "active",
        strikeCount: 0,
        cooldownUntil: null,
        lastError: null,
        lastUsedAt: null,
        consecutiveUses: 0,
      };
      state.accounts.push(record);
      compactState(state);
      state.updatedAt = formatLocalTimestamp(new Date());
      await this.saveState(state);
      return record;
    });
  }

  private async loadState(): Promise<AccountPoolState> {
    try {
      const raw = await readFile(POOL_STATE_PATH, "utf8");
      return JSON.parse(raw) as AccountPoolState;
    } catch {
      return {
        version: 1,
        desiredSize: 0,
        updatedAt: formatLocalTimestamp(new Date()),
        accounts: [],
      };
    }
  }

  private async saveState(state: AccountPoolState): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(POOL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private reactivateExpiredCooldowns(state: AccountPoolState): void {
    const now = Date.now();
    for (const account of state.accounts) {
      if (account.status !== "cooldown" || !account.cooldownUntil) {
        continue;
      }

      const cooldownDeadline = Date.parse(account.cooldownUntil.replace(" ", "T"));
      if (Number.isNaN(cooldownDeadline) || cooldownDeadline > now) {
        continue;
      }

      account.status = "active";
      account.cooldownUntil = null;
    }
  }

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function countNonDeletedAccounts(state: AccountPoolState): number {
  return state.accounts.filter((account) => account.status !== "deleted").length;
}

function compareByLeastRecentlyUsed(left: PoolAccountRecord, right: PoolAccountRecord): number {
  const leftTime = left.lastUsedAt ? Date.parse(left.lastUsedAt.replace(" ", "T")) : 0;
  const rightTime = right.lastUsedAt ? Date.parse(right.lastUsedAt.replace(" ", "T")) : 0;
  return leftTime - rightTime;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1_000);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactState(state: AccountPoolState): void {
  if (state.accounts.length <= MAX_POOL_SIZE) {
    return;
  }

  const kept = state.accounts
    .slice()
    .sort((left, right) => {
      if (left.status === "deleted" && right.status !== "deleted") {
        return 1;
      }
      if (left.status !== "deleted" && right.status === "deleted") {
        return -1;
      }
      return compareByLeastRecentlyUsed(left, right);
    })
    .slice(0, MAX_POOL_SIZE);

  state.accounts = kept;
}

function summarizeState(state: AccountPoolState): AccountPoolSummary {
  const counts: AccountPoolSummary = {
    desiredSize: state.desiredSize,
    total: state.accounts.length,
    active: 0,
    cooldown: 0,
    deleted: 0,
    nonDeleted: 0,
  };

  for (const account of state.accounts) {
    if (account.status === "active") {
      counts.active += 1;
    } else if (account.status === "cooldown") {
      counts.cooldown += 1;
    } else if (account.status === "deleted") {
      counts.deleted += 1;
    }

    if (account.status !== "deleted") {
      counts.nonDeleted += 1;
    }
  }

  return counts;
}
