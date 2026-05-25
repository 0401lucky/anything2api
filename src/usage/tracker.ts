import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface UsageRecord {
  ts: Date;
  accountId: string;
  model: string;
  route: string;
  promptChars: number;
  completionChars: number;
  status: "ok" | "error";
  errorKind?: string;
  latencyMs: number;
}

export interface UsageSummary {
  totalRequests: number;
  byModel: Record<string, { requests: number; promptChars: number; completionChars: number }>;
  byAccount: Record<string, { requests: number; promptChars: number; completionChars: number }>;
}

export class UsageTracker {
  public constructor(private readonly filePath: string, private readonly maxBytes: number) {}

  public async record(entry: UsageRecord): Promise<void> {
    const line = JSON.stringify({
      ts: entry.ts.toISOString(),
      accountId: entry.accountId,
      model: entry.model,
      route: entry.route,
      promptChars: entry.promptChars,
      completionChars: entry.completionChars,
      status: entry.status,
      ...(entry.errorKind ? { errorKind: entry.errorKind } : {}),
      latencyMs: entry.latencyMs,
    });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${line}\n`, "utf8");
  }

  public async maybeRotate(): Promise<void> {
    try {
      const stats = await stat(this.filePath);
      if (stats.size <= this.maxBytes) return;
      await rename(this.filePath, `${this.filePath}.1`);
      await writeFile(this.filePath, "", "utf8");
    } catch {
      // not present, ignore
    }
  }

  public async aggregate(): Promise<UsageSummary> {
    const summary: UsageSummary = {
      totalRequests: 0,
      byModel: {},
      byAccount: {},
    };
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return summary;
    }

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as UsageRecord;
        summary.totalRequests += 1;

        const modelKey = entry.model || "unknown";
        const mb = (summary.byModel[modelKey] ??= { requests: 0, promptChars: 0, completionChars: 0 });
        mb.requests += 1;
        mb.promptChars += entry.promptChars ?? 0;
        mb.completionChars += entry.completionChars ?? 0;

        const acctKey = entry.accountId || "unknown";
        const ab = (summary.byAccount[acctKey] ??= { requests: 0, promptChars: 0, completionChars: 0 });
        ab.requests += 1;
        ab.promptChars += entry.promptChars ?? 0;
        ab.completionChars += entry.completionChars ?? 0;
      } catch {
        // skip malformed
      }
    }

    return summary;
  }
}
