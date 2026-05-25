import { randomBytes, timingSafeEqual } from "node:crypto";

interface SessionEntry {
  user: string;
  expiresAt: number;
}

export class ConsoleSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  public constructor(private readonly ttlMs: number) {}

  public create(user: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { user, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  public validate(token: string | undefined): SessionEntry | null {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return entry;
  }

  public destroy(token: string): void {
    this.sessions.delete(token);
  }
}

export class RateLimiter {
  private readonly events = new Map<string, number[]>();

  public constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  public recordFailureAndCheck(key: string): boolean {
    const now = Date.now();
    const arr = this.events.get(key) ?? [];
    const filtered = arr.filter((ts) => now - ts < this.windowMs);
    filtered.push(now);
    this.events.set(key, filtered);
    return filtered.length <= this.maxAttempts;
  }
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}
