import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import { firefox, type BrowserContext as PlaywrightBrowserContext, type Page as PlaywrightPage } from "playwright-core";
import puppeteerExtraModule from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type {
  Browser as PuppeteerBrowser,
  HTTPRequest as PuppeteerRequest,
  HTTPResponse as PuppeteerResponse,
  Page as PuppeteerPage,
} from "puppeteer";

import { resolveModel } from "./model-catalog.js";
import type { StableFingerprint } from "./fingerprint.js";
import { formatError } from "./util/error.js";

const puppeteerExtra = puppeteerExtraModule as unknown as {
  use(plugin: unknown): void;
  launch(options: unknown): Promise<PuppeteerBrowser>;
};
puppeteerExtra.use(StealthPlugin());

const ANYTHING_BASE_URL = process.env.ANYTHING_BASE_URL ?? "https://www.anything.com";
const HEADLESS_MODE = (process.env.HEADLESS ?? "true").toLowerCase();
const DEFAULT_CAMOUFOX_PATH = "/app/camoufox-linux/camoufox";

export type BrowserEngine = "chromium" | "firefox";
type BrowserPage = PuppeteerPage | PlaywrightPage;
type BrowserRequest = PuppeteerRequest | import("playwright-core").Request;
type BrowserResponse = PuppeteerResponse | import("playwright-core").Response;
type CommonElementHandle = {
  click(options?: { clickCount?: number }): Promise<void>;
  dispose(): Promise<void> | void;
  evaluate<T>(pageFunction: Function): Promise<T>;
};
type CommonPage = {
  on(event: "request", listener: (request: BrowserRequest) => void): void;
  on(event: "response", listener: (response: BrowserResponse) => void): void;
  $(selector: string): Promise<CommonElementHandle | null>;
  waitForSelector(selector: string, options: Record<string, unknown>): Promise<CommonElementHandle | null>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  evaluate<T>(pageFunction: Function, arg?: unknown): Promise<T>;
  focus(selector: string): Promise<void>;
  keyboard: {
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
};

export interface LoginLaunchOptions {
  accountDir: string;
  fingerprint: StableFingerprint;
  magicLink: string;
  log?: (message: string) => void;
}

export interface PromptRunResult {
  text: string;
  pageUrl: string;
  requests: Array<{
    url: string;
    method: string;
    resourceType: string;
    postData?: string;
  }>;
  responses: Array<{
    url: string;
    status: number;
    bodyPreview: string;
    contentType: string;
  }>;
  domSnapshot: string;
}

export type BrowserSessionHandle =
  | {
      engine: "chromium";
      browser: PuppeteerBrowser;
      accountDir: string;
      fingerprint: StableFingerprint;
    }
  | {
      engine: "firefox";
      context: PlaywrightBrowserContext;
      accountDir: string;
      fingerprint: StableFingerprint;
    };

export interface GraphqlGenerationResult {
  revisionId: string;
  status: string;
  response: string;
}

export async function launchAndLoginWithMagicLink(options: LoginLaunchOptions): Promise<{ finalUrl: string; title: string }> {
  const handle = await openBrowserSession(options.accountDir, options.fingerprint);

  try {
    const page = await openSessionPage(handle);
    await page.goto(normalizeMagicLinkForBrowser(options.magicLink), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForNonTrackingUrl(page, 60_000);
    await waitForSettledPage(page);

    const finalUrl = page.url();
    const title = await page.title();
    options.log?.(`[+] 浏览器登录完成: ${finalUrl}`);

    return {
      finalUrl,
      title,
    };
  } finally {
    await closeBrowserSession(handle);
  }
}

export async function openBrowserSession(
  accountDir: string,
  fingerprint: StableFingerprint,
  options: { headless?: boolean; display?: string; browserEngine?: BrowserEngine } = {},
): Promise<BrowserSessionHandle> {
  const engine = resolveBrowserEngine(options.browserEngine);
  if (engine === "firefox") {
    const context = await launchFirefoxContext({
      accountDir,
      fingerprint,
      headless: options.headless,
      display: options.display,
    });
    return {
      engine,
      context,
      accountDir,
      fingerprint,
    };
  }

  const browser = await launchChromiumBrowser({
    accountDir,
    fingerprint,
    headless: options.headless,
    display: options.display,
  });
  return {
    engine,
    browser,
    accountDir,
    fingerprint,
  };
}

export async function closeBrowserSession(handle: BrowserSessionHandle): Promise<void> {
  if (handle.engine === "firefox") {
    await handle.context.close().catch(() => undefined);
    return;
  }

  await handle.browser.close().catch(() => undefined);
}

export async function runPromptInBrowser(
  handle: BrowserSessionHandle,
  targetUrl: string,
  prompt: string,
  log: (message: string) => void = console.log,
): Promise<PromptRunResult> {
  const page = await openSessionPage(handle);

  const capturedRequests: PromptRunResult["requests"] = [];
  const capturedResponses: PromptRunResult["responses"] = [];
  const promptSnippet = prompt.slice(0, 120);
  const trackedRequests = new WeakSet<object>();
  const commonPage = asCommonPage(page);

  commonPage.on("request", (request: BrowserRequest) => {
    const postData = request.postData() ?? undefined;
    const isInteresting =
      request.resourceType() === "fetch" ||
      request.resourceType() === "xhr" ||
      request.resourceType() === "document";

    if (!isInteresting) {
      return;
    }

    if (postData?.includes(promptSnippet) || request.url().includes("/api/") || request.url().includes("graphql")) {
      trackedRequests.add(request);
      capturedRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData: truncate(postData, 1_000),
      });
    }
  });

  commonPage.on("response", async (response: BrowserResponse) => {
    const request = response.request();
    const contentType = response.headers()["content-type"] ?? "";
    const maybeInteresting =
      trackedRequests.has(request) ||
      response.url().includes("/api/") ||
      response.url().includes("graphql") ||
      contentType.includes("json") ||
      contentType.includes("event-stream");

    if (!maybeInteresting) {
      return;
    }

    try {
      const body = await response.text();
      capturedResponses.push({
        url: response.url(),
        status: response.status(),
        bodyPreview: truncate(body, 2_000) ?? "",
        contentType,
      });
    } catch (error) {
      capturedResponses.push({
        url: response.url(),
        status: response.status(),
        bodyPreview: `[unreadable] ${formatError(error)}`,
        contentType,
      });
    }
  });

  try {
    await page.goto(targetUrl || ANYTHING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForSettledPage(page);

    const inputSelector = await locatePromptInput(page);
    if (!inputSelector) {
      const domSnapshot = await snapshotText(page);
      throw new Error(`未找到可用输入框。页面快照:\n${domSnapshot}`);
    }

    await fillPrompt(page, inputSelector, prompt);
    await submitPrompt(page, inputSelector);
    await delay(6_000);

    const domSnapshot = await snapshotText(page);
    const extracted = extractBestText(capturedResponses) ?? domSnapshot;

    log(`[+] Prompt 执行完成，抓到 ${capturedRequests.length} 个请求 / ${capturedResponses.length} 个响应`);

    return {
      text: extracted,
      pageUrl: page.url(),
      requests: capturedRequests,
      responses: capturedResponses,
      domSnapshot,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function generateProjectGroupRevisionViaGraphql(options: {
  handle: BrowserSessionHandle;
  targetUrl: string;
  projectGroupId: string;
  prompt: string;
  preferredModel?: string;
  log?: (message: string) => void;
  onUpdate?: (rawText: string, status: string) => Promise<void> | void;
}): Promise<GraphqlGenerationResult> {
  const page = await openSessionPage(options.handle);
  const resolvedModel = resolveModel(options.preferredModel);

  try {
    await page.goto(options.targetUrl || ANYTHING_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await waitForSettledPage(page);

    const generateResult = await graphqlRequest(page, {
      operationName: "GenerateProjectGroupRevisionFromChat",
      variables: {
        input: {
          projectGroupId: options.projectGroupId,
          content: wrapPromptForModel(options.prompt, resolvedModel),
          viewingModuleId: null,
          action: "AUTO_SELECT_CHAT",
          useExtendedThinking: true,
          preferredGenerationProvider: resolvedModel.preferredGenerationProvider,
          threadId: null,
        },
      },
      extensions: {
        clientLibrary: {
          name: "@apollo/client",
          version: "4.1.6",
        },
      },
      query: `
mutation GenerateProjectGroupRevisionFromChat($input: GenerateProjectGroupRevisionFromChatInput!) {
  generateProjectGroupRevisionFromChat(input: $input) {
    success
    projectGroupRevision {
      id
      response
      status
      createdAt
      chat {
        id
        content
        __typename
      }
      __typename
    }
    askForUserProfileInfo
    errors {
      kind
      message
      __typename
    }
    __typename
  }
}
      `.trim(),
    });

    const generatePayload = asRecord(generateResult.data)?.generateProjectGroupRevisionFromChat;
    const generation = asRecord(generatePayload);
    const revision = asRecord(generation.projectGroupRevision);
    const revisionId = asString(revision.id);
    const status = asString(revision.status);
    const immediateResponse = asString(revision.response);
    const errors = generation.errors;

    if (!revisionId) {
      throw new Error(`生成请求未返回 revision id: ${JSON.stringify(errors ?? generation, null, 2)}`);
    }

    if (immediateResponse.trim()) {
      await options.onUpdate?.(immediateResponse, status || "COMPLETED");
      return {
        revisionId,
        status: status || "COMPLETED",
        response: immediateResponse,
      };
    }

    for (let attempt = 1; attempt <= 60; attempt += 1) {
      await delay(2_000);
      const pollResult = await graphqlRequest(page, {
        operationName: "GetLatestRevisionForProxy",
        variables: {
          projectGroupId: options.projectGroupId,
        },
        extensions: {
          clientLibrary: {
            name: "@apollo/client",
            version: "4.1.6",
          },
        },
        query: `
query GetLatestRevisionForProxy($projectGroupId: ID!) {
  projectGroupById(id: $projectGroupId) {
    id
    latestRevision {
      id
      response
      status
      createdAt
      chat {
        id
        content
        __typename
      }
      __typename
    }
    __typename
  }
}
        `.trim(),
      });

      const latestRevision = asRecord(asRecord(asRecord(pollResult.data).projectGroupById).latestRevision);
      const latestRevisionId = asString(latestRevision.id);
      const latestStatus = asString(latestRevision.status);
      const latestResponse = asString(latestRevision.response);

      options.log?.(`[*] 轮询 revision ${attempt}/60: id=${latestRevisionId}, status=${latestStatus}`);

      if (latestRevisionId !== revisionId) {
        continue;
      }

      if (latestResponse.trim()) {
        await options.onUpdate?.(latestResponse, latestStatus);
      }

      if (latestResponse.trim()) {
        return {
          revisionId,
          status: latestStatus || "COMPLETED",
          response: latestResponse,
        };
      }

      if (["FAILED", "ERROR", "CANCELLED"].includes(latestStatus)) {
        throw new Error(`生成失败: revision=${revisionId}, status=${latestStatus}`);
      }
    }

    throw new Error(`等待生成结果超时: revision=${revisionId}, status=${status}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

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

  const page = await openSessionPage(options.handle);
  await page.goto(`${ANYTHING_BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  try {
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("登录已被取消");
      await delay(pollMs);

      const url = page.url();
      if (!isAnythingPageUrl(url)) continue;
      if (url.match(/\/(login|signup|auth)(\/|$|\?)/i)) continue;

      const cookies = await getSessionCookies(options.handle, page);
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

interface LaunchOptions {
  accountDir: string;
  fingerprint: StableFingerprint;
  headless?: boolean;
  display?: string;
}

export function resolveBrowserEngine(preferred?: BrowserEngine): BrowserEngine {
  if (preferred) {
    return preferred;
  }

  const configured = (process.env.BROWSER_ENGINE ?? "").trim().toLowerCase();
  if (configured === "firefox" || configured === "camoufox") {
    return "firefox";
  }
  if (configured === "chromium" || configured === "chrome" || configured === "puppeteer") {
    return "chromium";
  }
  if (process.env.CAMOUFOX_EXECUTABLE_PATH?.trim() || process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH?.trim()) {
    return "firefox";
  }

  return "chromium";
}

async function openSessionPage(handle: BrowserSessionHandle): Promise<BrowserPage> {
  const page = handle.engine === "firefox"
    ? await handle.context.newPage()
    : await handle.browser.newPage();
  await preparePage(page, handle);
  return page;
}

function asCommonPage(page: BrowserPage): CommonPage {
  return page as unknown as CommonPage;
}

async function getSessionCookies(
  handle: BrowserSessionHandle,
  page: BrowserPage,
): Promise<Array<{ name: string; value: string }>> {
  if (handle.engine === "firefox") {
    return await handle.context.cookies();
  }

  return await (page as PuppeteerPage).cookies();
}

async function launchFirefoxContext(options: LaunchOptions): Promise<PlaywrightBrowserContext> {
  const userDataDir = path.join(options.accountDir, "user-data");
  await mkdir(userDataDir, { recursive: true });

  const headless = options.headless ?? (HEADLESS_MODE !== "false");
  const executablePath = await resolveFirefoxExecutablePath();
  if (!executablePath) {
    throw new Error(
      "未找到 Firefox/Camoufox 可执行文件。请设置 CAMOUFOX_EXECUTABLE_PATH 或 PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH。",
    );
  }

  const context = await firefox.launchPersistentContext(userDataDir, {
    executablePath,
    headless,
    viewport: options.fingerprint.viewport,
    userAgent: options.fingerprint.userAgent,
    locale: options.fingerprint.locale,
    colorScheme: options.fingerprint.colorScheme,
    extraHTTPHeaders: {
      "accept-language": options.fingerprint.acceptLanguage,
    },
    ignoreHTTPSErrors: true,
    env: {
      ...process.env,
      ...(options.display ? { DISPLAY: options.display } : {}),
    },
    firefoxUserPrefs: {
      "dom.webdriver.enabled": false,
      "intl.accept_languages": options.fingerprint.acceptLanguage,
      "privacy.resistFingerprinting": false,
    },
  });
  await context.addInitScript(applyFingerprint, options.fingerprint);
  return context;
}

async function resolveFirefoxExecutablePath(): Promise<string | undefined> {
  const candidates = [
    process.env.CAMOUFOX_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH,
    DEFAULT_CAMOUFOX_PATH,
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
  ].filter((item): item is string => Boolean(item?.trim()));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function launchChromiumBrowser(options: LaunchOptions): Promise<PuppeteerBrowser> {
  await mkdir(path.join(options.accountDir, "user-data"), { recursive: true });

  const headless = options.headless ?? (HEADLESS_MODE !== "false");

  const prevDisplay = process.env.DISPLAY;
  if (options.display) process.env.DISPLAY = options.display;
  try {
    return await puppeteerExtra.launch({
      headless,
      ignoreDefaultArgs: ["--enable-automation"],
      ignoreHTTPSErrors: true,
      userDataDir: path.join(options.accountDir, "user-data"),
      defaultViewport: null,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
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
  } finally {
    if (options.display) {
      if (prevDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = prevDisplay;
    }
  }
}

async function preparePage(page: BrowserPage, handle: BrowserSessionHandle): Promise<void> {
  if (handle.engine === "firefox") {
    await (page as PlaywrightPage).setViewportSize(handle.fingerprint.viewport);
    await (page as PlaywrightPage).emulateMedia({ colorScheme: handle.fingerprint.colorScheme });
    await (page as PlaywrightPage).setExtraHTTPHeaders({
      "accept-language": handle.fingerprint.acceptLanguage,
    });
    return;
  }

  const pageHandle = page as PuppeteerPage;
  await pageHandle.setUserAgent(handle.fingerprint.userAgent);
  await pageHandle.setViewport(handle.fingerprint.viewport);
  await pageHandle.setExtraHTTPHeaders({
    "accept-language": handle.fingerprint.acceptLanguage,
  });
  await pageHandle.emulateMediaFeatures([{ name: "prefers-color-scheme", value: handle.fingerprint.colorScheme }]);
  await pageHandle.evaluateOnNewDocument(applyFingerprint, handle.fingerprint);
}

async function waitForNonTrackingUrl(page: BrowserPage, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (url && !url.includes("/ls/click")) {
      return;
    }
    await delay(500);
  }
  throw new Error("Magic Link 打开后长时间停留在跟踪跳转页");
}

async function waitForSettledPage(page: BrowserPage): Promise<void> {
  const waitForIdle = isPlaywrightPage(page)
    ? page.waitForLoadState("networkidle", { timeout: 10_000 })
    : page.waitForNetworkIdle({ idleTime: 1_000, timeout: 10_000 });
  await Promise.all([
    waitForIdle.catch(() => undefined),
    delay(2_000),
  ]);
}

function isPlaywrightPage(page: BrowserPage): page is PlaywrightPage {
  return typeof (page as PlaywrightPage).waitForLoadState === "function";
}

async function waitForVisibleSelector(page: BrowserPage, selector: string): Promise<CommonElementHandle | null> {
  if (isPlaywrightPage(page)) {
    return await asCommonPage(page).waitForSelector(selector, {
      timeout: 20_000,
      state: "visible",
    });
  }

  return await asCommonPage(page).waitForSelector(selector, {
    timeout: 20_000,
    visible: true,
  });
}

async function locatePromptInput(page: BrowserPage): Promise<string | null> {
  const commonPage = asCommonPage(page);
  const selectors = [
    "textarea",
    "[contenteditable='true'][role='textbox']",
    "[contenteditable='true']",
  ];

  for (const selector of selectors) {
    const handle = await commonPage.$(selector);
    if (handle) {
      await handle.dispose();
      return selector;
    }
  }

  return null;
}

async function fillPrompt(page: BrowserPage, selector: string, prompt: string): Promise<void> {
  const element = await waitForVisibleSelector(page, selector);
  const commonPage = asCommonPage(page);

  if (!element) {
    throw new Error(`未找到输入框: ${selector}`);
  }

  await element.click({ clickCount: 3 });
  await commonPage.keyboard.press("Backspace");

  if (selector === "textarea") {
    await commonPage.type(selector, prompt, { delay: 10 });
    return;
  }

  await commonPage.evaluate(
    (arg: unknown) => {
      const { value, currentSelector } = arg as { value: string; currentSelector: string };
      const node = document.querySelector(currentSelector);
      if (!node) {
        return;
      }

      node.textContent = value;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    },
    { value: prompt, currentSelector: selector },
  );
}

async function submitPrompt(page: BrowserPage, selector: string): Promise<void> {
  const commonPage = asCommonPage(page);
  const submitSelectors = [
    "button[type='submit']",
    "form button",
    "button[aria-label*='Send']",
    "button[title*='Send']",
  ];

  for (const submitSelector of submitSelectors) {
    const button = await commonPage.$(submitSelector);
    if (!button) {
      continue;
    }

    const disabled = await button.evaluate((node: Element) => {
      const element = node as HTMLButtonElement;
      return element.disabled || element.getAttribute("aria-disabled") === "true";
    });

    if (disabled) {
      await button.dispose();
      continue;
    }

    await button.click();
    await button.dispose();
    return;
  }

  await commonPage.focus(selector);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await commonPage.keyboard.down(modifier);
  await commonPage.keyboard.press("Enter");
  await commonPage.keyboard.up(modifier);
}

async function snapshotText(page: BrowserPage): Promise<string> {
  const bodyText = await asCommonPage(page).evaluate<string>(() => document.body?.innerText ?? "");
  return truncate(bodyText.replace(/\n{3,}/g, "\n\n").trim(), 4_000) ?? "";
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return value;
  }

  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

function extractBestText(responses: PromptRunResult["responses"]): string | null {
  for (const response of responses) {
    const extracted = extractTextFromPayload(response.bodyPreview);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

async function graphqlRequest(
  page: BrowserPage,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const probe = await asCommonPage(page).evaluate<{
    status: number;
    retryAfter: string | null;
    text: string;
  }>(async (requestPayload: unknown) => {
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

function extractTextFromPayload(raw: string): string | null {
  const asJson = tryParseJson(raw);
  if (asJson) {
    const text = findInterestingText(asJson);
    if (text) {
      return text;
    }
  }

  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (const line of dataLines) {
    const parsed = tryParseJson(line);
    if (!parsed) {
      continue;
    }

    const text = findInterestingText(parsed);
    if (text) {
      return text;
    }
  }

  return null;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findInterestingText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 20 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return trimmed;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findInterestingText(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ["output_text", "text", "content", "message", "completion", "response"];

  for (const key of preferredKeys) {
    const nested = findInterestingText(record[key]);
    if (nested) {
      return nested;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findInterestingText(nestedValue);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function wrapPromptForModel(
  prompt: string,
  resolvedModel: ReturnType<typeof resolveModel>,
): string {
  if (!resolvedModel.canonical || resolvedModel.canonical === "anything-auto") {
    return prompt;
  }

  return `[Requested model: ${resolvedModel.canonical}]\n\n${prompt}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeMagicLinkForBrowser(magicLink: string): string {
  if (!magicLink.startsWith("http://url")) {
    return magicLink;
  }

  return magicLink.replace(/^http:\/\//i, "https://");
}

function isAnythingPageUrl(value: string): boolean {
  try {
    const currentHost = new URL(value).hostname.replace(/^www\./i, "");
    const expectedHost = new URL(ANYTHING_BASE_URL).hostname.replace(/^www\./i, "");
    return currentHost === expectedHost;
  } catch {
    return false;
  }
}

function applyFingerprint(fingerprint: StableFingerprint): void {
  const defineValue = <T>(target: object, key: string, value: T) => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
    });
  };

  try {
    delete (Navigator.prototype as unknown as Record<string, unknown>).webdriver;
  } catch {
    // ignore
  }

  defineValue(navigator, "webdriver", undefined);
  defineValue(navigator, "platform", fingerprint.platform);
  defineValue(navigator, "language", fingerprint.locale);
  defineValue(navigator, "languages", fingerprint.acceptLanguage.split(",").map((item) => item.split(";")[0] ?? item));
  defineValue(navigator, "hardwareConcurrency", fingerprint.hardwareConcurrency);
  defineValue(navigator, "deviceMemory", fingerprint.deviceMemory);
  defineValue(navigator, "maxTouchPoints", fingerprint.maxTouchPoints);

  const patchWebGl = (prototype: WebGLRenderingContext | WebGL2RenderingContext) => {
    const original = prototype.getParameter;
    prototype.getParameter = function patchedGetParameter(parameter: number): unknown {
      if (parameter === 37445) {
        return fingerprint.webglVendor;
      }
      if (parameter === 37446) {
        return fingerprint.webglRenderer;
      }
      return original.call(this, parameter);
    };
  };

  patchWebGl(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") {
    patchWebGl(WebGL2RenderingContext.prototype);
  }
}
