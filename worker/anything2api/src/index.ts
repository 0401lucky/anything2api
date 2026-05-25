import { DurableObject } from "cloudflare:workers";

const STREAMABLE_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/responses",
  "/v1/messages",
]);

export interface Env {
  STREAM_RELAY: DurableObjectNamespace<StreamRelayDurableObject>;
  UPSTREAM_BASE_URL: string;
  STREAM_SHARDS?: string;
  MAX_CONCURRENT_STREAMS_PER_SHARD?: string;
  WORKER_AUTH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: { message: "Unauthorized" } }, 401);
    }

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return withCors(json({ ok: true }, 200));
    }

    if (await shouldUseDurableObject(request)) {
      const shard = pickShard(request, env);
      const stub = env.STREAM_RELAY.getByName(`stream-${shard}`);
      const relayRequest = buildUpstreamRequest(request, env, {
        doMode: "stream",
        shard,
      });
      const response = await stub.fetch(relayRequest);
      return withCors(response);
    }

    const upstreamRequest = buildUpstreamRequest(request, env, {
      doMode: "direct",
      shard: "none",
    });
    const response = await fetchUpstream(upstreamRequest, request.url);
    return withCors(response);
  },
} satisfies ExportedHandler<Env>;

export class StreamRelayDurableObject extends DurableObject<Env> {
  private activeStreams = 0;

  async fetch(request: Request): Promise<Response> {
    const maxConcurrent = parsePositiveInteger(this.env.MAX_CONCURRENT_STREAMS_PER_SHARD, 4);
    if (this.activeStreams >= maxConcurrent) {
      return json(
        {
          error: {
            message: "Too many concurrent streaming requests for this shard",
            shard: this.ctx.id.toString(),
          },
        },
        429,
      );
    }

    this.activeStreams += 1;

    try {
      const upstreamRequest = buildUpstreamRequest(request, this.env, {
        doMode: "stream",
        shard: request.headers.get("x-anything2api-shard") ?? "unknown",
      });
      const upstream = await fetchUpstream(upstreamRequest, request.url);

      if (!upstream.body) {
        return upstream;
      }

      const headers = new Headers(upstream.headers);
      headers.set("x-anything2api-stream-relay", "durable-object");

      const abortController = new AbortController();
      request.signal.addEventListener("abort", () => abortController.abort(), { once: true });

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.body!.getReader();
          try {
            while (!abortController.signal.aborted) {
              const { value, done } = await reader.read();
              if (done) {
                controller.close();
                break;
              }
              if (value) {
                controller.enqueue(value);
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        },
        cancel() {
          abortController.abort();
        },
      });

      return new Response(stream, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } finally {
      this.activeStreams -= 1;
    }
  }
}

async function shouldUseDurableObject(request: Request): Promise<boolean> {
  if (request.method !== "POST") {
    return false;
  }

  const url = new URL(request.url);
  if (!STREAMABLE_PATHS.has(url.pathname)) {
    return false;
  }

  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return true;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return false;
  }

  try {
    const body = await request.clone().json<Record<string, unknown>>();
    return body.stream === true;
  } catch {
    return false;
  }
}

function buildUpstreamRequest(
  request: Request,
  env: Env,
  meta: {
    doMode: "stream" | "direct";
    shard: string;
  },
): Request {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(incomingUrl.pathname + incomingUrl.search, env.UPSTREAM_BASE_URL);
  const headers = new Headers(request.headers);

  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-proto");
  headers.delete("content-length");

  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-anything2api-via", "cloudflare-worker");
  headers.set("x-anything2api-do-mode", meta.doMode);
  headers.set("x-anything2api-shard", meta.shard);

  return new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow",
  });
}

function pickShard(request: Request, env: Env): string {
  const shardCount = parsePositiveInteger(env.STREAM_SHARDS, 16);
  const seed =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("cf-ray") ??
    crypto.randomUUID();
  const value = djb2(seed);
  return String(value % shardCount);
}

function djb2(input: string): number {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAuthorized(request: Request, env: Env): boolean {
  const requiredToken = env.WORKER_AUTH_TOKEN;
  if (!requiredToken) {
    return true;
  }

  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${requiredToken}`;
}

function cloneResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchUpstream(request: Request, workerUrl: string): Promise<Response> {
  const upstream = await fetch(request, {
    redirect: "follow",
  });

  const headers = new Headers(upstream.headers);
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocationToWorker(location, workerUrl));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function rewriteLocationToWorker(location: string, workerUrl: string): string {
  try {
    const worker = new URL(workerUrl);
    const target = new URL(location, worker);
    if (target.origin === worker.origin) {
      return target.toString();
    }
    return new URL(`${target.pathname}${target.search}${target.hash}`, worker).toString();
  } catch {
    return location;
  }
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type, x-api-key, anthropic-version");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
