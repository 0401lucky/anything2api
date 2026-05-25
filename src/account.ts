import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { closeBrowserSession, openBrowserSession, probeCookieSession, runInteractiveLogin } from "./browser.js";
import type { BrowserEngine } from "./browser.js";
import { normalizeImportedCookies, type StoredCookie } from "./cookies.js";
import type { StableFingerprint } from "./fingerprint.js";
import { loadOrCreateFingerprint } from "./fingerprint.js";
import { formatError } from "./util/error.js";
import { formatLocalTimestamp } from "./util/time.js";

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
  browserEngine?: BrowserEngine;
  cookies?: StoredCookie[];
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
      browserEngine: session.browserEngine ?? "chromium",
      cookieCount: session.cookies?.length ?? 0,
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

export interface LoginInteractiveOptions {
  display?: string;
  headless?: boolean;
  log?: (message: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CookieSessionImportOptions {
  cookies: unknown;
  finalUrl?: string;
  log?: (message: string) => void;
}

export async function createSessionFromCookies(
  options: CookieSessionImportOptions,
): Promise<AccountSessionRecord> {
  const log = options.log ?? console.log;
  const cookies = normalizeImportedCookies(options.cookies);
  const probe = await probeCookieSession({
    cookies,
    finalUrl: options.finalUrl,
  });

  const targetDir = getAccountDir(probe.email);
  await mkdir(targetDir, { recursive: true });
  const fingerprint = await loadOrCreateFingerprint(targetDir, probe.email);
  const verified = await probeCookieSession({
    cookies,
    fingerprint,
    finalUrl: options.finalUrl,
  });

  const session: AccountSessionRecord = {
    version: 1,
    accountId: createAccountId(verified.email),
    accountDir: targetDir,
    email: verified.email,
    mailboxKey: "",
    userId: verified.userId,
    projectGroupId: verified.projectGroupId,
    finalUrl: verified.finalUrl,
    title: verified.title,
    createdAt: formatLocalTimestamp(new Date()),
    fingerprint,
    cookies,
  };

  await writeFile(path.join(targetDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await saveLatestSession(session);
  log(`[+] Cookie 账号会话已保存: ${path.join(targetDir, "session.json")}`);
  return session;
}

export async function loginInteractive(
  options: LoginInteractiveOptions = {},
): Promise<AccountSessionRecord> {
  const log = options.log ?? console.log;

  // Stage browser in a temporary "pending" dir; move to canonical account dir after we know the email.
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

    // Move user-data + fingerprint from pending → canonical dir.
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
      browserEngine: handle.engine,
    };

    await writeFile(path.join(targetDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await saveLatestSession(session);
    log(`[+] 账号会话已保存: ${path.join(targetDir, "session.json")}`);
    return session;
  } finally {
    await closeBrowserSession(handle);
    const { rm } = await import("node:fs/promises");
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
