import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { launchAndLoginWithMagicLink } from "./browser.js";
import { loadOrCreateFingerprint, type StableFingerprint } from "./fingerprint.js";
import {
  createTemporaryMailbox,
  generateEmailPrefix,
  pollMagicLoginEmail,
  signupAnything,
  type MagicLoginMail,
  type SignupResult,
  type TemporaryMailbox,
} from "./register.js";
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
}

export interface AccountContext {
  mailbox: TemporaryMailbox;
  signupResult: SignupResult;
  mail: MagicLoginMail;
  session: AccountSessionRecord;
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

export function getAccountDir(email: string): string {
  const accountId = createAccountId(email);
  const safeEmail = email.replace(/[^a-z0-9@._-]+/gi, "_");
  return path.join(DATA_DIR, "accounts", `${safeEmail}-${accountId}`);
}

export async function registerAndLogin(log: (message: string) => void = console.log): Promise<AccountContext> {
  const prefix = generateEmailPrefix();
  log(`[*] 生成邮箱前缀: ${prefix}`);

  const mailbox = await createTemporaryMailbox(prefix);
  log(`[+] 临时邮箱创建成功: ${mailbox.mail}`);

  const signupResult = await signupAnything(mailbox.mail);
  const userId = signupResult.user?.id ?? "";
  const projectGroupId = signupResult.projectGroup?.id ?? "";
  log(`[+] Anything 协议注册成功: email=${mailbox.mail}, user_id=${userId}, project_group_id=${projectGroupId}`);

  const mail = await pollMagicLoginEmail(mailbox, 24, 5, log);
  log(`[+] 收到 Magic Login Link 邮件: subject=${mail.subject}`);
  log(`[+] 提取注册链接成功: ${mail.magicLink}`);

  const accountDir = getAccountDir(mailbox.mail);
  const fingerprint = await loadOrCreateFingerprint(accountDir, mailbox.mail);
  const loginResult = await launchAndLoginWithMagicLink({
    accountDir,
    fingerprint,
    magicLink: mail.magicLink,
    log,
  });

  const session: AccountSessionRecord = {
    version: 1,
    accountId: createAccountId(mailbox.mail),
    accountDir,
    email: mailbox.mail,
    mailboxKey: mailbox.key,
    userId,
    projectGroupId,
    finalUrl: loginResult.finalUrl,
    title: loginResult.title,
    createdAt: formatLocalTimestamp(new Date()),
    fingerprint,
  };

  await mkdir(accountDir, { recursive: true });
  await writeFile(path.join(accountDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await saveLatestSession(session);
  log(`[+] 账号会话已保存: ${path.join(accountDir, "session.json")}`);

  return {
    mailbox,
    signupResult,
    mail,
    session,
  };
}

export async function loadOrCreateSession(log: (message: string) => void = console.log): Promise<AccountSessionRecord> {
  const existing = await loadLatestSession();
  if (existing) {
    log(`[+] 复用最近账号: ${existing.email}`);
    return existing;
  }

  const created = await registerAndLogin(log);
  return created.session;
}

export function createAccountId(email: string): string {
  return createHash("sha1").update(email).digest("hex").slice(0, 12);
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
