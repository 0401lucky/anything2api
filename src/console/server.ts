import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AccountPool } from "../account-pool.js";
import type { AccountSessionRecord } from "../account.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { VncSupervisor } from "../vnc/supervisor.js";
import { constantTimeStringEqual, ConsoleSessionStore, RateLimiter } from "../auth/console-session.js";

const STATIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "static");

export interface ConsoleServerOptions {
  password: string;
  username?: string;
  sessionTtlMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

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
  importCookieSession(args: {
    cookies: unknown;
    finalUrl?: string;
  }): Promise<AccountSessionRecord>;
}

export class ConsoleServer {
  private readonly sessions: ConsoleSessionStore;
  private readonly limiter: RateLimiter;
  private loginState: {
    vncSessionId: string;
    wsPort: number;
    status: "provisioning" | "waiting" | "detecting" | "done" | "failed" | "cancelled";
    controller: AbortController;
    error?: string;
    session?: AccountSessionRecord;
    startedAt: number;
  } | null = null;

  public constructor(
    private readonly options: ConsoleServerOptions,
    private readonly deps: ConsoleServerDeps,
  ) {
    this.sessions = new ConsoleSessionStore(options.sessionTtlMs);
    this.limiter = new RateLimiter(options.rateLimitMax, options.rateLimitWindowMs);
  }

  public async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname.replace(/^\/admin/, "") || "/";

    if (pathname === "/login" && request.method === "GET") {
      return this.serveStatic(response, "login.html");
    }

    if (pathname === "/style.css") {
      return this.serveStatic(response, "style.css");
    }

    if (pathname === "/api/login" && request.method === "POST") {
      return this.handleLogin(request, response);
    }

    if (pathname === "/api/logout" && request.method === "POST") {
      return this.handleLogout(request, response);
    }

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

    if (pathname === "/api/accounts" && request.method === "GET") {
      const accounts = await this.deps.pool.listAccounts();
      this.sendJson(response, 200, accounts.map(serializeAccountForConsole));
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
      try {
        const imported = await this.deps.importArchive(request);
        this.sendJson(response, 200, serializeAccountForConsole(imported));
      } catch (error) {
        this.sendJson(response, 400, { error: { message: (error as Error).message } });
      }
      return;
    }

    if (pathname === "/api/accounts/cookies" && request.method === "POST") {
      try {
        const body = await readJsonBody(request);
        const payload = (body ?? {}) as { cookies?: unknown; finalUrl?: unknown };
        const imported = await this.deps.importCookieSession({
          cookies: payload.cookies ?? body,
          finalUrl: typeof payload.finalUrl === "string" ? payload.finalUrl : undefined,
        });
        await this.deps.pool.addPreparedSession(imported);
        this.sendJson(response, 200, serializeAccountForConsole(imported));
      } catch (error) {
        this.sendJson(response, 400, { error: { message: (error as Error).message } });
      }
      return;
    }

    if (pathname === "/api/usage" && request.method === "GET") {
      const usage = this.deps.usage ? await this.deps.usage.aggregate() : { totalRequests: 0 };
      this.sendJson(response, 200, usage);
      return;
    }

    if (pathname === "/api/summary" && request.method === "GET") {
      const [accounts, summary, usage] = await Promise.all([
        this.deps.pool.listAccounts(),
        this.deps.pool.getSummary(),
        this.deps.usage ? this.deps.usage.aggregate() : Promise.resolve({ totalRequests: 0 }),
      ]);
      this.sendJson(response, 200, {
        accounts: {
          ...summary,
          lastUsedAt: accounts
            .map((account) => account.lastUsedAt)
            .filter((value): value is string => !!value)
            .sort()
            .at(-1) ?? null,
        },
        usage,
        login: this.serializeLoginState(),
        vnc: this.deps.vnc.getStatus(),
      });
      return;
    }

    if (pathname === "/api/login/start" && request.method === "POST") {
      if (this.loginState && ["provisioning", "waiting", "detecting"].includes(this.loginState.status)) {
        this.sendJson(response, 409, { error: { message: "login already in progress" } });
        return;
      }
      const vnc = await this.deps.vnc.start();
      const state = {
        vncSessionId: vnc.sessionId,
        wsPort: vnc.wsPort,
        status: "provisioning" as const,
        controller: new AbortController(),
        startedAt: Date.now(),
      };
      this.loginState = state;
      void (async () => {
        try {
          state.status = "waiting" as any;
          const session = await this.deps.loginInteractive({
            display: vnc.display,
            log: (m) => console.log(m),
            signal: state.controller.signal,
          });
          state.status = "done" as any;
          (state as any).session = session;
          await this.deps.pool.addPreparedSession(session);
        } catch (error) {
          state.status = "failed" as any;
          (state as any).error = (error as Error).message;
        } finally {
          await this.deps.vnc.stopAny();
        }
      })();
      this.sendJson(response, 200, { sessionId: vnc.sessionId, vncWsUrl: `/admin/vnc/${vnc.sessionId}` });
      return;
    }

    if (pathname === "/api/login/status" && request.method === "GET") {
      this.sendJson(response, 200, this.serializeLoginState());
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

    if (pathname.startsWith("/novnc/")) {
      const sub = pathname.slice("/novnc/".length);
      const servedBundled = await this.tryServeFromRoot(response, path.join(STATIC_ROOT, "novnc"), sub);
      if (servedBundled) return;
      const systemNovncRoot = process.env.NOVNC_DIR ?? "/usr/share/novnc";
      const servedSystem = await this.tryServeFromRoot(response, systemNovncRoot, sub);
      if (servedSystem) return;
      this.sendJson(response, 404, { error: { message: "novnc asset not found" } });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      return this.serveStatic(response, "index.html");
    }
    if (pathname === "/app.js") return this.serveStatic(response, "app.js");
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

  private async tryServeFromRoot(response: ServerResponse, root: string, subPath: string): Promise<boolean> {
    const resolvedRoot = path.resolve(root);
    const file = path.resolve(resolvedRoot, subPath);
    if (!isInsideRoot(resolvedRoot, file)) return false;

    try {
      await stat(file);
    } catch {
      return false;
    }

    response.writeHead(200, {
      "content-type": guessContentType(file),
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(file).pipe(response);
    return true;
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = pickClientIp(request);
    const body = await readJsonBody(request);
    const { username, password } = (body ?? {}) as { username?: string; password?: string };

    const okUser = !this.options.username || (!!username && constantTimeStringEqual(username, this.options.username));
    const okPass = !!password && constantTimeStringEqual(password, this.options.password);

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

  public requireSessionByToken(token: string | undefined): { user: string } | null {
    const entry = this.sessions.validate(token);
    return entry ? { user: entry.user } : null;
  }

  public getLoginStatus(): { vncSessionId: string; status: string; wsPort: number } | null {
    return this.loginState
      ? { vncSessionId: this.loginState.vncSessionId, status: this.loginState.status, wsPort: this.loginState.wsPort }
      : null;
  }

  private serializeLoginState(): unknown {
    if (!this.loginState) return { status: "idle" };
    return {
      vncSessionId: this.loginState.vncSessionId,
      wsPort: this.loginState.wsPort,
      status: this.loginState.status,
      error: this.loginState.error,
      session: this.loginState.session ? serializeAccountForConsole(this.loginState.session) : undefined,
      startedAt: this.loginState.startedAt,
    };
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
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function isInsideRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function serializeAccountForConsole(session: AccountSessionRecord): Record<string, unknown> {
  const { cookies, ...safeSession } = session;
  return {
    ...safeSession,
    cookieCount: cookies?.length ?? 0,
  };
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
