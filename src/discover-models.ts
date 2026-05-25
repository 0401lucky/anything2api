import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const ANYTHING_BASE_URL = process.env.ANYTHING_BASE_URL ?? "https://www.anything.com";

async function main(): Promise<void> {
  const html = await fetchText(ANYTHING_BASE_URL);

  const providers = matchJsonArray(html, /"portkey-providers":(\[[^\]]+\])/);
  const enabledIntegrations = matchJsonArray(html, /"enabledIntegrations":(\[[^\]]+\])/);
  const flags = extractBooleanFlags(html, [
    "gpt-5-4-enabled",
    "gpt-52-enabled",
    "opus-46-enabled",
    "gemini-31-pro-enabled",
    "gemini-3-enabled",
  ]);

  const summary = {
    source: ANYTHING_BASE_URL,
    observedAt: new Date().toISOString(),
    providers,
    flags,
    enabledIntegrations,
    suggestedModels: buildSuggestedModels(providers, flags),
  };

  console.log(JSON.stringify(summary, null, 2));
}

async function fetchText(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const target = new URL(url);
    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`fetch failed: ${statusCode}`));
          response.resume();
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );

    request.setTimeout(30_000, () => {
      request.destroy(new Error(`request timeout: ${url}`));
    });
    request.on("error", reject);
    request.end();
  });
}

function matchJsonArray(input: string, pattern: RegExp): string[] {
  const match = pattern.exec(input);
  if (!match?.[1]) {
    return [];
  }

  try {
    return JSON.parse(match[1]) as string[];
  } catch {
    return [];
  }
}

function extractBooleanFlags(input: string, names: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const name of names) {
    const match = new RegExp(`"${escapeRegExp(name)}":(true|false)`).exec(input);
    result[name] = match?.[1] === "true";
  }
  return result;
}

function buildSuggestedModels(providers: string[], flags: Record<string, boolean>): string[] {
  const models = new Set<string>(providers);

  if (flags["gpt-5-4-enabled"]) models.add("gpt-5.4");
  if (flags["gpt-52-enabled"]) models.add("gpt-52");
  if (flags["opus-46-enabled"]) models.add("opus-46");
  if (flags["gemini-31-pro-enabled"]) models.add("gemini-31-pro");
  if (flags["gemini-3-enabled"]) models.add("gemini-3");

  return [...models];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
