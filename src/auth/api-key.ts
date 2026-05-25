import type { IncomingMessage } from "node:http";

export function parseApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function checkApiKey(request: IncomingMessage, allowedKeys: readonly string[]): boolean {
  if (allowedKeys.length === 0) return false;

  const auth = pickHeader(request.headers["authorization"]);
  if (auth) {
    const lowered = auth.toLowerCase();
    if (lowered.startsWith("bearer ")) {
      const candidate = auth.slice(7).trim();
      if (allowedKeys.includes(candidate)) return true;
    }
  }

  const xApiKey = pickHeader(request.headers["x-api-key"]);
  if (xApiKey && allowedKeys.includes(xApiKey.trim())) return true;

  return false;
}

function pickHeader(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}
