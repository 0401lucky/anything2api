import { parentPort, workerData } from "node:worker_threads";

import { registerAndLogin } from "./account.js";
import { formatError } from "./util/error.js";

interface WorkerConfig {
  hotTarget: number;
  maxPoolSize: number;
  idleDelayMs: number;
  successDelayMs: number;
  failureDelayMs: number;
}

interface DecisionMessage {
  type: "decision";
  requestId: number;
  shouldRegister: boolean;
}

if (!parentPort) {
  throw new Error("pool-expander worker requires parentPort");
}
const port = parentPort;

const config = workerData as WorkerConfig;
let requestId = 0;
const pending = new Map<number, (message: DecisionMessage) => void>();

port.on("message", (message: DecisionMessage) => {
  if (message.type !== "decision") {
    return;
  }

  const resolver = pending.get(message.requestId);
  if (!resolver) {
    return;
  }

  pending.delete(message.requestId);
  resolver(message);
});

void mainLoop().catch((error) => {
  port.postMessage({
    type: "fatal",
    error: formatError(error),
  });
});

async function mainLoop(): Promise<void> {
  while (true) {
    const shouldRegister = await askShouldRegister();
    if (!shouldRegister) {
      await sleep(config.idleDelayMs);
      continue;
    }

    try {
      const created = await registerAndLogin((message) => {
        port.postMessage({
          type: "log",
          message,
        });
      });

      port.postMessage({
        type: "account-ready",
        session: created.session,
      });
      await sleep(config.successDelayMs);
    } catch (error) {
      port.postMessage({
        type: "account-failed",
        error: formatError(error),
      });
      await sleep(config.failureDelayMs);
    }
  }
}

async function askShouldRegister(): Promise<boolean> {
  const id = requestId;
  requestId += 1;

  const decision = new Promise<DecisionMessage>((resolve) => {
    pending.set(id, resolve);
  });

  port.postMessage({
    type: "need-work",
    requestId: id,
    hotTarget: config.hotTarget,
    maxPoolSize: config.maxPoolSize,
  });

  const message = await decision;
  return message.shouldRegister;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
