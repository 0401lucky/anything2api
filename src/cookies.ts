export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export function normalizeImportedCookies(input: unknown): StoredCookie[] {
  const parsed = typeof input === "string" ? parseCookieText(input) : input;
  const rawCookies = extractCookieList(parsed);
  const cookies = rawCookies.map(normalizeCookie).filter((cookie): cookie is StoredCookie => !!cookie);

  if (!cookies.some(isLikelyAuthCookie)) {
    throw new Error("Cookie 中未找到 lS_authToken、refresh_token 或 authjs session，请确认已在本机浏览器登录 anything.com 后再导出。");
  }

  return dedupeCookies(cookies);
}

export function buildCookieHeader(cookies: readonly StoredCookie[]): string {
  return cookies
    .filter((cookie) => cookie.name && cookie.value !== undefined)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function findCookieValue(cookies: readonly StoredCookie[], name: string): string | null {
  return cookies.find((cookie) => cookie.name === name && cookie.value)?.value ?? null;
}

function parseCookieText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Cookie 内容为空");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return parseCookieHeaderLikeText(trimmed);
  }
}

function parseCookieHeaderLikeText(value: string): StoredCookie[] {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map<StoredCookie | null>((part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain: ".anything.com",
        path: "/",
      };
    })
    .filter((cookie): cookie is StoredCookie => cookie !== null);
}

function extractCookieList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.cookies)) {
      return record.cookies;
    }

    return Object.entries(record).map(([name, cookieValue]) => ({
      name,
      value: cookieValue,
      domain: ".anything.com",
      path: "/",
    }));
  }

  throw new Error("Cookie 格式无效，请粘贴 Cookie-Editor 导出的 JSON 或 name=value 字符串。");
}

function normalizeCookie(value: unknown): StoredCookie | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name = asString(record.name);
  const cookieValue = asString(record.value);
  if (!name || cookieValue === undefined) {
    return null;
  }

  return {
    name,
    value: cookieValue,
    domain: asString(record.domain) || ".anything.com",
    path: asString(record.path) || "/",
    expires: asOptionalNumber(record.expires ?? record.expirationDate ?? record.expiry),
    httpOnly: asOptionalBoolean(record.httpOnly),
    secure: asOptionalBoolean(record.secure),
    sameSite: asString(record.sameSite) || undefined,
  };
}

function dedupeCookies(cookies: StoredCookie[]): StoredCookie[] {
  const byKey = new Map<string, StoredCookie>();
  for (const cookie of cookies) {
    byKey.set(`${cookie.domain ?? ""}\n${cookie.path ?? ""}\n${cookie.name}`, cookie);
  }
  return [...byKey.values()];
}

function isLikelyAuthCookie(cookie: StoredCookie): boolean {
  if (!cookie.value) {
    return false;
  }

  const lowerName = cookie.name.toLowerCase();
  return (
    cookie.name === "lS_authToken" ||
    lowerName === "refresh_token" ||
    lowerName.includes("authjs.session-token") ||
    lowerName.includes("session-token") ||
    lowerName.includes("auth-token") ||
    lowerName.includes("auth_token")
  );
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
