import { randomInt } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const ANYTHING_BASE_URL = process.env.ANYTHING_BASE_URL ?? "https://www.anything.com";
const GRAPHQL_URL = `${ANYTHING_BASE_URL}/api/graphql`;
const REFERRAL_CODE = process.env.ANYTHING_REFERRAL_CODE ?? "code";
const SIGNUP_URL = `${ANYTHING_BASE_URL}/signup?rid=${encodeURIComponent(REFERRAL_CODE)}`;
const LANGUAGE = process.env.ANYTHING_LANGUAGE ?? "zh-CN";
const USER_AGENT =
  process.env.ANYTHING_USER_AGENT ??
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    "Chrome/130.0.0.0 Safari/537.36",
  ].join(" ");
const RAZMAIL_BASE_URL = process.env.RAZMAIL_BASE_URL ?? "https://mail.razkord.top";
const MAX_CONSECUTIVE_FAILURES = parsePositiveInteger(process.env.MAX_CONSECUTIVE_FAILURES, 3);
const OUTPUT_EMAILS_FILE = path.resolve(process.cwd(), process.env.OUTPUT_EMAILS_FILE ?? "registered_emails.txt");
const OUTPUT_RESULTS_FILE = path.resolve(
  process.cwd(),
  process.env.OUTPUT_RESULTS_FILE ?? "registered_results.jsonl",
);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const SIGNUP_MUTATION = `
mutation SignUpWithAppPrompt($input: SignUpWithAppPromptInput!) {
  signUpAndStartAgent(input: $input) {
    ... on SignUpWithoutAppPromptPayload {
      success
      accessToken
      project {
        id
        projectGroup {
          id
          __typename
        }
        __typename
      }
      projectGroup {
        id
        __typename
      }
      user {
        ...UserFragment
        __typename
      }
      organization {
        id
        __typename
      }
      __typename
    }
    ... on SignUpAndStartAgentErrorResult {
      success
      errors {
        kind
        message
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment UserFragment on User {
  id
  email
  roles
  badges
  displayName
  username
  profile {
    firstName
    lastName
    photoURL
    xUsername
    instagramUsername
    facebookUsername
    githubUsername
    linkedinUsername
    tiktokUsername
    __typename
  }
  __typename
}
`.trim();

export interface TemporaryMailbox {
  mail: string;
  key: string;
}

export interface MagicLoginMail {
  status: string;
  subject: string;
  raw: string;
  headers: Record<string, unknown>;
  receivedAt?: number;
  magicLink: string;
}

export interface SignupResult {
  success: boolean;
  accessToken?: string;
  project?: {
    id?: string;
    projectGroup?: {
      id?: string;
    };
  };
  projectGroup?: {
    id?: string;
  };
  user?: {
    id?: string;
    email?: string;
  };
  organization?: {
    id?: string;
  };
  errors?: Array<{
    kind?: string;
    message?: string;
  }>;
  __typename?: string;
}

export interface OpenMagicLinkResult {
  finalUrl: string;
  title: string;
  redirectChain: string[];
}

export interface PersistedRegistrationRecord {
  email: string;
  user_id: string;
  project_group_id: string;
  final_url: string;
  title: string;
  created_at: string;
}

export interface RegisterOneResult {
  email: string;
  user_id: string;
  project_group_id: string;
  magic_link_subject: string;
  final_url: string;
  title: string;
}

export interface RegisterDependencies {
  createTemporaryMailbox(prefix?: string): Promise<TemporaryMailbox>;
  signupAnything(email: string): Promise<SignupResult>;
  pollMagicLoginEmail(mailbox: TemporaryMailbox): Promise<MagicLoginMail>;
  openMagicLinkDirect(magicLink: string): Promise<OpenMagicLinkResult>;
  appendRegisteredResult(record: PersistedRegistrationRecord): Promise<void>;
  log(message: string): void;
}

interface ResponseData {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  url: string;
  redirectChain: string[];
}

interface SessionRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  public update(setCookieHeader: string | string[] | undefined): void {
    const headerValues = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];

    for (const headerValue of headerValues) {
      const firstSegment = headerValue.split(";", 1)[0]?.trim();
      if (!firstSegment) {
        continue;
      }

      const separatorIndex = firstSegment.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const name = firstSegment.slice(0, separatorIndex).trim();
      const value = firstSegment.slice(separatorIndex + 1).trim();
      this.cookies.set(name, value);
    }
  }

  public toHeaderValue(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }

    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

class HttpSession {
  private readonly cookieJar = new CookieJar();

  public constructor(private readonly defaultHeaders: Record<string, string>) {}

  public async request(options: SessionRequestOptions): Promise<ResponseData> {
    return this.performRequest(
      {
        ...options,
        method: options.method ?? "GET",
        headers: {
          ...this.defaultHeaders,
          ...(options.headers ?? {}),
        },
      },
      [],
      options.maxRedirects ?? 10,
    );
  }

  private async performRequest(
    options: Required<Pick<SessionRequestOptions, "url" | "method" | "headers">> &
      Omit<SessionRequestOptions, "url" | "method" | "headers">,
    redirectChain: string[],
    redirectsRemaining: number,
  ): Promise<ResponseData> {
    const targetUrl = new URL(options.url);
    const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
    const headers = {
      ...options.headers,
    };
    const cookieHeader = this.cookieJar.toHeaderValue();

    if (cookieHeader && !headers.cookie) {
      headers.cookie = cookieHeader;
    }

    if (body !== undefined) {
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    return new Promise<ResponseData>((resolve, reject) => {
      const requestImpl = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requestImpl(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port ? Number(targetUrl.port) : undefined,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: options.method,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          response.on("end", async () => {
            this.cookieJar.update(response.headers["set-cookie"]);

            const statusCode = response.statusCode ?? 0;
            const responseText = Buffer.concat(chunks).toString("utf8");
            const locationHeader = response.headers.location;
            const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

            if (location && REDIRECT_STATUS_CODES.has(statusCode)) {
              if (redirectsRemaining <= 0) {
                reject(new Error(`重定向次数过多: ${options.url}`));
                return;
              }

              const nextUrl = new URL(location, targetUrl).toString();
              const shouldRewriteToGet =
                statusCode === 303 ||
                ((statusCode === 301 || statusCode === 302) &&
                  options.method !== "GET" &&
                  options.method !== "HEAD");

              const nextMethod = shouldRewriteToGet ? "GET" : options.method;
              const nextOptions = {
                ...options,
                url: nextUrl,
                method: nextMethod,
                body: shouldRewriteToGet ? undefined : options.body,
                json: shouldRewriteToGet ? undefined : options.json,
                headers: {
                  ...options.headers,
                },
              };

              if (shouldRewriteToGet) {
                delete nextOptions.headers["content-length"];
                delete nextOptions.headers["content-type"];
              }

              try {
                resolve(await this.performRequest(nextOptions, [...redirectChain, nextUrl], redirectsRemaining - 1));
              } catch (error) {
                reject(error);
              }
              return;
            }

            resolve({
              statusCode,
              headers: response.headers,
              text: responseText,
              url: options.url,
              redirectChain,
            });
          });
        },
      );

      request.setTimeout(options.timeoutMs ?? 30_000, () => {
        request.destroy(new Error(`请求超时: ${options.url}`));
      });

      request.on("error", reject);

      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}

export function generateEmailPrefix(): string {
  const lettersLength = randomInt(4, 7);
  const mixedLength = randomInt(2, 6);
  const letters = randomString("abcdefghijklmnopqrstuvwxyz", lettersLength);
  const mixed = randomString("abcdefghijklmnopqrstuvwxyz0123456789", mixedLength);
  return `${letters}${mixed}`;
}

export function decodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    const hex = normalized.slice(index + 1, index + 3);

    if (current === "=" && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }

    bytes.push(current.charCodeAt(0));
  }

  return Buffer.from(bytes).toString("utf8");
}

export function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>(.*?)<\/title>/is.exec(html);
  if (!match) {
    return "";
  }
  return (match[1] ?? "").replace(/\s+/g, " ").trim();
}

export function extractMagicLoginLink(emailContent: string): string | null {
  const decodedContent = decodeHtmlEntities(decodeQuotedPrintable(emailContent));
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  const preferredTokens = ["sign in", "magic login", "log in", "login"];
  const anchors: Array<{ href: string; text: string }> = [];

  for (const match of decodedContent.matchAll(anchorPattern)) {
    const href = normalizeUrlCandidate(match[1] ?? "");
    const text = stripHtmlTags(match[2] ?? "").toLowerCase();
    if (!href) {
      continue;
    }

    anchors.push({ href, text });
    if (preferredTokens.some((token) => text.includes(token))) {
      return href;
    }
  }

  for (const anchor of anchors) {
    if (anchor.href.includes("anything.com/ls/click")) {
      return anchor.href;
    }
  }

  const urlPattern = /https?:\/\/[^\s"'<>]+/gi;
  for (const match of decodedContent.matchAll(urlPattern)) {
    const candidate = normalizeUrlCandidate(match[0]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

export function isValidMagicLoginCandidate(subject: string, magicLink: string | null): boolean {
  const normalizedSubject = subject.toLowerCase();
  return (
    normalizedSubject === "magic login link" ||
    (magicLink !== null &&
      (magicLink.includes("anything.com/ls/click") || magicLink.includes("anything.com/auth/magic-link")))
  );
}

export function looksLikeWelcomeMail(subject: string): boolean {
  return subject.toLowerCase().startsWith("welcome to anything");
}

export async function createTemporaryMailbox(prefix?: string): Promise<TemporaryMailbox> {
  const payload = prefix ? { mail: prefix } : {};
  const response = await withRetries(async () => {
    const session = new HttpSession({
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    });
    return session.request({
      url: `${RAZMAIL_BASE_URL}/get-mail`,
      method: "POST",
      json: payload,
      timeoutMs: 45_000,
    });
  });

  ensureOk(response, "Razmail 创建邮箱失败");
  const data = parseJson(response.text, "Razmail 创建邮箱返回了无效 JSON");

  if (typeof data.mail !== "string" || typeof data.key !== "string") {
    throw new Error(`Razmail 创建邮箱响应异常: ${response.text}`);
  }

  return {
    mail: data.mail,
    key: data.key,
  };
}

export async function readMailbox(mailbox: TemporaryMailbox): Promise<Record<string, unknown>> {
  const response = await withRetries(async () => {
    const session = new HttpSession({
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    });
    return session.request({
      url: `${RAZMAIL_BASE_URL}/read-mail`,
      method: "POST",
      json: {
        key: mailbox.key,
        mail: mailbox.mail,
      },
      timeoutMs: 45_000,
    });
  });

  ensureOk(response, "Razmail 读取邮件失败");
  return parseJson(response.text, "Razmail 读取邮件返回了无效 JSON");
}

export async function pollMagicLoginEmail(
  mailbox: TemporaryMailbox,
  maxAttempts = 24,
  intervalSeconds = 5,
  log: (message: string) => void = console.log,
): Promise<MagicLoginMail> {
  let consecutiveNonLoginMails = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const payload = await readMailbox(mailbox);
    const status = asString(payload.status);
    const headers = asRecord(payload.headers);
    const raw = asString(payload.raw);
    const subject = normalizeSubject(headers.subject, raw);

    log(`[*] 拉取邮件 ${attempt}/${maxAttempts}，status=${status || "<unknown>"}，subject=${subject || "<empty>"}`);

    if (status !== "received") {
      consecutiveNonLoginMails = 0;
      await sleep(intervalSeconds * 1_000);
      continue;
    }

    const magicLink = extractMagicLoginLink(raw);
    const normalizedSubject = subject.toLowerCase();
    if (!magicLink || !isValidMagicLoginCandidate(subject, magicLink)) {
      if (normalizedSubject === "magic login link") {
        throw new Error("已收到 Magic Login Link 邮件，但未能提取链接");
      }

      if (looksLikeWelcomeMail(subject)) {
        throw new Error(`收到 Welcome 邮件，立即放弃当前账号: subject=${subject}`);
      } else {
        consecutiveNonLoginMails += 1;
        if (consecutiveNonLoginMails >= 3) {
          throw new Error(`连续收到非登录邮件，放弃当前账号: subject=${subject}`);
        }
      }

      await sleep(intervalSeconds * 1_000);
      continue;
    }

    consecutiveNonLoginMails = 0;

    return {
      status,
      subject,
      raw,
      headers,
      receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : undefined,
      magicLink,
    };
  }

  throw new Error("轮询超时，未收到 Magic Login Link 邮件");
}

export async function signupAnything(email: string): Promise<SignupResult> {
  const session = buildSignupSession();
  try {
    const warmupResponse = await session.request({
      url: SIGNUP_URL,
      timeoutMs: 45_000,
    });
    ensureOk(warmupResponse, "Anything 注册前预热失败");
  } catch {
    // 某些节点上预热页偶发超时，但后续 GraphQL 仍可直接提交。
  }

  const response = await withRetries(async () => {
    return session.request({
      url: GRAPHQL_URL,
      method: "POST",
      timeoutMs: 60_000,
      json: {
        operationName: "SignUpWithAppPrompt",
        variables: {
          input: {
            email,
            postLoginRedirect: null,
            language: LANGUAGE,
            referralCode: REFERRAL_CODE,
          },
        },
        extensions: {
          clientLibrary: {
            name: "@apollo/client",
            version: "4.1.6",
          },
        },
        query: SIGNUP_MUTATION,
      },
    });
  });
  ensureOk(response, "Anything 注册接口失败");

  const payload = parseJson(response.text, "Anything GraphQL 返回了无效 JSON");
  const data = asRecord(payload.data);
  const rawResult = asRecord(data.signUpAndStartAgent);

  if (Object.keys(rawResult).length === 0) {
    throw new Error(`GraphQL 响应异常: ${response.text}`);
  }

  const result = rawResult as unknown as SignupResult;

  if (result.__typename === "SignUpAndStartAgentErrorResult") {
    throw new Error(`Anything 注册失败: ${JSON.stringify(result.errors ?? [], null, 2)}`);
  }

  if (!result.success) {
    throw new Error(`Anything 注册未成功: ${JSON.stringify(result, null, 2)}`);
  }

  return result;
}

export async function openMagicLinkDirect(magicLink: string): Promise<OpenMagicLinkResult> {
  const session = buildMagicLinkSession();
  const response = await session.request({
    url: magicLink,
    timeoutMs: 60_000,
    maxRedirects: 15,
  });
  ensureOk(response, "Magic Link 直连失败");

  const finalUrl = response.url;
  const title = extractHtmlTitle(response.text);

  if (!finalUrl.includes("anything.com") || finalUrl.includes("/ls/click")) {
    throw new Error(
      `Magic Link 直连后未跳转到目标站点，当前 URL: ${finalUrl}；重定向链路: ${JSON.stringify(
        response.redirectChain,
        null,
        2,
      )}`,
    );
  }

  if (!title && !response.text.toLowerCase().includes("anything")) {
    throw new Error("Magic Link 已直连，但页面未返回可识别的 Anything 内容");
  }

  return {
    finalUrl,
    title,
    redirectChain: response.redirectChain,
  };
}

export async function appendRegisteredResult(record: PersistedRegistrationRecord): Promise<void> {
  await appendFile(OUTPUT_EMAILS_FILE, `${record.email}\n`, "utf8");
  await appendFile(OUTPUT_RESULTS_FILE, `${JSON.stringify(record)}\n`, "utf8");
}

export function buildRuntimeDependencies(log: (message: string) => void = console.log): RegisterDependencies {
  return {
    createTemporaryMailbox,
    signupAnything,
    pollMagicLoginEmail: (mailbox) => pollMagicLoginEmail(mailbox, 24, 5, log),
    openMagicLinkDirect,
    appendRegisteredResult,
    log,
  };
}

export async function registerOne(
  index: number,
  dependencies: RegisterDependencies = buildRuntimeDependencies(),
): Promise<RegisterOneResult> {
  dependencies.log("=".repeat(72));
  dependencies.log(`[*] 开始第 ${index} 次注册`);

  const prefix = generateEmailPrefix();
  dependencies.log(`[*] 生成邮箱前缀: ${prefix}`);
  const mailbox = await dependencies.createTemporaryMailbox(prefix);
  dependencies.log(`[+] 临时邮箱创建成功: ${mailbox.mail}`);

  const signupResult = await dependencies.signupAnything(mailbox.mail);
  const userId = signupResult.user?.id ?? "";
  const projectGroupId = signupResult.projectGroup?.id ?? "";
  dependencies.log(
    `[+] Anything 协议注册成功: email=${mailbox.mail}, user_id=${userId}, project_group_id=${projectGroupId}`,
  );

  const mail = await dependencies.pollMagicLoginEmail(mailbox);
  dependencies.log(`[+] 收到 Magic Login Link 邮件: subject=${mail.subject}`);
  dependencies.log(`[+] 提取注册链接成功: ${mail.magicLink}`);

  const protocolResult = await dependencies.openMagicLinkDirect(mail.magicLink);
  dependencies.log(`[+] HTTP 直连打开成功: ${protocolResult.finalUrl}`);
  dependencies.log(`[+] 页面标题: ${protocolResult.title}`);

  const result: RegisterOneResult = {
    email: mailbox.mail,
    user_id: userId,
    project_group_id: projectGroupId,
    magic_link_subject: mail.subject,
    final_url: protocolResult.finalUrl,
    title: protocolResult.title,
  };

  await dependencies.appendRegisteredResult({
    email: mailbox.mail,
    user_id: userId,
    project_group_id: projectGroupId,
    final_url: protocolResult.finalUrl,
    title: protocolResult.title,
    created_at: formatLocalTimestamp(new Date()),
  });

  dependencies.log("=".repeat(72));
  dependencies.log("[SUCCESS] Anything 注册与 Magic Link HTTP 直连流程完成");
  dependencies.log(JSON.stringify(result, null, 2));
  dependencies.log(`[+] 已追加邮箱记录到: ${OUTPUT_EMAILS_FILE}`);

  return result;
}

export async function main(): Promise<void> {
  const log = console.log;
  const dependencies = buildRuntimeDependencies(log);

  log("=".repeat(72));
  log("[*] Anything TypeScript 单文件协议注册机启动");
  log("[*] 邮箱渠道: Razmail");
  log(`[*] Razmail 基础地址: ${RAZMAIL_BASE_URL}`);
  log(`[*] 成功邮箱记录文件: ${OUTPUT_EMAILS_FILE}`);
  log(`[*] 详细结果记录文件: ${OUTPUT_RESULTS_FILE}`);
  log(`[*] 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次后自动停止`);
  log("=".repeat(72));

  let consecutiveFailures = 0;
  let totalSuccesses = 0;
  let totalAttempts = 0;

  while (true) {
    totalAttempts += 1;

    try {
      await registerOne(totalAttempts, dependencies);
      totalSuccesses += 1;
      consecutiveFailures = 0;
      log(`[*] 当前统计: 尝试=${totalAttempts}, 成功=${totalSuccesses}, 连续失败=${consecutiveFailures}`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      consecutiveFailures += 1;
      log(`[-] 第 ${totalAttempts} 次注册失败: ${formatError(error)}`);
      log(`[*] 当前统计: 尝试=${totalAttempts}, 成功=${totalSuccesses}, 连续失败=${consecutiveFailures}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`[-] 连续失败已达到 ${MAX_CONSECUTIVE_FAILURES} 次，脚本停止`);
        break;
      }

      log("[*] 将继续下一次注册");
    }
  }
}

function buildSignupSession(): HttpSession {
  return new HttpSession({
    accept: "application/graphql-response+json,application/json;q=0.9",
    "accept-language": `${LANGUAGE},zh;q=0.9`,
    "apollographql-client-name": "flux-web",
    "cache-control": "no-cache",
    "content-type": "application/json",
    origin: ANYTHING_BASE_URL,
    pragma: "no-cache",
    referer: SIGNUP_URL,
    "user-agent": USER_AGENT,
  });
}

function buildMagicLinkSession(): HttpSession {
  return new HttpSession({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": `${LANGUAGE},zh;q=0.9`,
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: SIGNUP_URL,
    "upgrade-insecure-requests": "1",
    "user-agent": USER_AGENT,
  });
}

function normalizeSubject(headerSubject: unknown, raw: string): string {
  if (typeof headerSubject === "string" && headerSubject.trim()) {
    return headerSubject.trim();
  }

  const decodedRaw = decodeQuotedPrintable(raw);
  const match = /^subject:\s*(.+)$/im.exec(decodedRaw);
  return match?.[1]?.trim() ?? "";
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#61;/gi, "=");
}

function normalizeUrlCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/^["'<(]+/, "")
    .replace(/[>"')]+$/, "")
    .replace(/&amp;/gi, "&");
}

function ensureOk(response: ResponseData, message: string): void {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return;
  }

  throw new Error(`${message}: HTTP ${response.statusCode} ${response.text}`);
}

function parseJson(text: string, errorMessage: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${errorMessage}: ${formatError(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function randomString(alphabet: string, length: number): string {
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += alphabet[randomInt(0, alphabet.length)];
  }

  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function withRetries<T>(work: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
      await sleep(1_000 * attempt);
    }
  }

  throw lastError;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMainModule(metaUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return path.resolve(entryPath) === fileURLToPath(metaUrl);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FATAL] ${formatError(error)}`);
    process.exitCode = 1;
  });
}
