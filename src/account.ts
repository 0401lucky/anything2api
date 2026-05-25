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
