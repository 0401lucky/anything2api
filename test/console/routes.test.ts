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
  res.writeHead = ((status: number, h?: any) => { collected.status = status; if (h) Object.assign(collected.headers!, h); return res; }) as any;
  res.end = ((body?: any) => { collected.body = typeof body === "string" ? body : ""; return res; }) as any;
  res.setHeader = ((name: string, value: any) => { collected.headers![name.toLowerCase()] = String(value); }) as any;
  return { req, res, collected };
}

function makeDeps(): import("../../src/console/server.js").ConsoleServerDeps {
  return {
    pool: {
      listAccounts: async () => [],
      removeAccount: async () => undefined,
      reactivateAccount: async () => null,
      addPreparedSession: async () => null,
    } as any,
    usage: null,
    importArchive: async () => ({}) as any,
    exportAccount: async () => ({ archivePath: "", cleanup: async () => undefined }),
    vnc: {
      start: async () => ({ sessionId: "x", display: ":99", wsPort: 6080 }),
      stop: async () => undefined,
      stopAny: async () => undefined,
      getStatus: () => ({ running: false }),
    } as any,
    loginInteractive: async () => ({}) as any,
  };
}

test("ConsoleServer rejects wrong password", async () => {
  const server = new ConsoleServer({
    password: "secret",
    sessionTtlMs: 60_000,
    rateLimitMax: 5,
    rateLimitWindowMs: 60_000,
  }, makeDeps());
  const { req, res, collected } = makeReqRes("POST");
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
  }, makeDeps());
  const { req, res, collected } = makeReqRes("POST");
  (req as any)[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ password: "secret" }));
  };
  await server.handle(req, res, new URL("http://x/admin/api/login"));
  assert.equal(collected.status, 200);
  assert.match(collected.headers!["set-cookie"] ?? "", /a2a_console=/);
});
