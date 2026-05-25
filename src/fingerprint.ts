import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StableFingerprint {
  version: number;
  seed: string;
  userAgent: string;
  acceptLanguage: string;
  locale: string;
  platform: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  colorScheme: "light" | "dark";
  webglVendor: string;
  webglRenderer: string;
}

const USER_AGENT_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
];

const WEBGL_PROFILES = [
  {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
];

export async function loadOrCreateFingerprint(accountDir: string, accountKey: string): Promise<StableFingerprint> {
  const fingerprintPath = path.join(accountDir, "fingerprint.json");

  try {
    const raw = await readFile(fingerprintPath, "utf8");
    return JSON.parse(raw) as StableFingerprint;
  } catch {
    const fingerprint = createStableFingerprint(accountKey);
    await mkdir(accountDir, { recursive: true });
    await writeFile(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`, "utf8");
    return fingerprint;
  }
}

export function createStableFingerprint(seedInput: string): StableFingerprint {
  const seed = createHash("sha256").update(seedInput).digest("hex");
  const rng = createSeededRng(seed);
  const webgl = pick(WEBGL_PROFILES, rng);

  return {
    version: 1,
    seed,
    userAgent: pick(USER_AGENT_POOL, rng),
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
    locale: "zh-CN",
    platform: "Win32",
    viewport: {
      width: 1280 + randomBetween(rng, 0, 240),
      height: 800 + randomBetween(rng, 0, 220),
      deviceScaleFactor: pick([1, 1.25, 1.5], rng),
    },
    hardwareConcurrency: pick([4, 8, 12, 16], rng),
    deviceMemory: pick([4, 8, 16], rng),
    maxTouchPoints: pick([0, 0, 0, 1], rng),
    colorScheme: pick(["light", "dark"], rng),
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
  };
}

function createSeededRng(seed: string): () => number {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;

  return () => {
    if (offset >= pool.length) {
      pool = createHash("sha256").update(`${seed}:${counter}`).digest();
      offset = 0;
      counter += 1;
    }

    const value = pool.readUInt32BE(offset);
    offset += 4;
    return value / 0xffffffff;
  };
}

function randomBetween(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(values: readonly T[], rng: () => number): T {
  if (values.length === 0) {
    throw new Error("pick() requires at least one value");
  }

  const selected = values[Math.floor(rng() * values.length)];
  return selected ?? values[0]!;
}
