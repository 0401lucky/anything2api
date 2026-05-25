import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AccountPool } from "../account-pool.js";
import type { AccountSessionRecord } from "../account.js";
import type { UsageTracker } from "../usage/tracker.js";
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
}

export class ConsoleServer {
  private readonly sessions: ConsoleSessionStore;
  private readonly limiter: RateLimiter;

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
      try {
        const imported = await this.deps.importArchive(request);
        this.sendJson(response, 200, imported);
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
