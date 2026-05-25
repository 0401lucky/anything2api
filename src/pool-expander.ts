import { Worker } from "node:worker_threads";

import type { AccountPool } from "./account-pool.js";
import { formatError } from "./register.js";

const HOT_POOL_TARGET = parsePositiveInteger(process.env.POOL_SIZE, 32);
const MAX_POOL_SIZE = parsePositiveInteger(process.env.MAX_POOL_SIZE, 1024);
const IDLE_DELAY_MS = parsePositiveInteger(process.env.BACKGROUND_REFILL_IDLE_DELAY_MS, 15000);
const SUCCESS_DELAY_MS = parsePositiveInteger(process.env.BACKGROUND_REFILL_SUCCESS_DELAY_MS, 10000);
const FAILURE_DELAY_MS = parsePositiveInteger(process.env.BACKGROUND_REFILL_FAILURE_DELAY_MS, 30000);

export class BackgroundPoolExpander {
  private worker: Worker | null = null;
  private stopping = false;

  public constructor(
    private readonly pool: AccountPool,
    private readonly log: (message: string) => void = console.log,
  ) {}

  public start(): void {
    if (this.worker || MAX_POOL_SIZE <= HOT_POOL_TARGET) {
      return;
    }

    this.stopping = false;
    this.worker = new Worker(new URL("./pool-expander-worker.js", import.meta.url), {
      workerData: {
        hotTarget: HOT_POOL_TARGET,
        maxPoolSize: MAX_POOL_SIZE,
        idleDelayMs: IDLE_DELAY_MS,
        successDelayMs: SUCCESS_DELAY_MS,
        failureDelayMs: FAILURE_DELAY_MS,
      },
    });

    this.worker.on("message", (message) => {
      void this.handleMessage(message).catch((error) => {
        this.log(`[-] 背景补货线程消息处理失败: ${formatError(error)}`);
      });
    });

    this.worker.on("error", (error) => {
      this.log(`[-] 背景补货线程异常: ${formatError(error)}`);
    });

    this.worker.on("exit", (code) => {
      this.log(`[!] 背景补货线程退出: code=${code}`);
      this.worker = null;
      if (!this.stopping) {
        setTimeout(() => this.start(), 5000);
      }
    });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (!this.worker) {
      return;
    }

    const worker = this.worker;
    this.worker = null;
    await worker.terminate();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.worker || !message || typeof message !== "object") {
      return;
    }

    const record = message as Record<string, unknown>;
    const type = record.type;

    if (type === "need-work") {
      const requestId = typeof record.requestId === "number" ? record.requestId : -1;
      const summary = await this.pool.getSummary();
      const shouldRegister = summary.nonDeleted >= HOT_POOL_TARGET && summary.nonDeleted < MAX_POOL_SIZE;
      this.worker.postMessage({
        type: "decision",
        requestId,
        shouldRegister,
      });
      return;
    }

    if (type === "account-ready") {
      await this.pool.addPreparedSession(record.session as never);
      this.log("[+] 背景补货线程已添加一个账号到总池");
      return;
    }

    if (type === "account-failed") {
      this.log(`[-] 背景补货线程单号失败: ${typeof record.error === "string" ? record.error : "unknown error"}`);
      return;
    }

    if (type === "log" && typeof record.message === "string") {
      this.log(record.message);
      return;
    }

    if (type === "fatal") {
      this.log(`[-] 背景补货线程致命错误: ${typeof record.error === "string" ? record.error : "unknown error"}`);
    }
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
