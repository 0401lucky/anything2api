import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Socket } from "node:net";

export interface VncSupervisorOptions {
  display?: string;
  vncPort?: number;
  wsPort?: number;
  spawn?: typeof nativeSpawn;
  sleep?: (ms: number) => Promise<void>;
  waitForPort?: (port: number, host: string, timeoutMs: number) => Promise<void>;
}

export interface VncSessionHandle {
  sessionId: string;
  display: string;
  wsPort: number;
}

export class VncSupervisor {
  private active: { sessionId: string; display: string; wsPort: number; processes: ChildProcess[] } | null = null;

  public constructor(private readonly options: VncSupervisorOptions = {}) {}

  public async start(): Promise<VncSessionHandle> {
    if (this.active) throw new Error("VNC already running");
    if (process.platform === "win32" && !this.options.spawn) {
      throw new Error("VNC 登录仅支持 Linux/Docker 环境；Windows 本地请使用 npm run login 或在 Docker 中运行控制台。");
    }

    const display = this.options.display ?? ":99";
    const vncPort = this.options.vncPort ?? 5900;
    const wsPort = this.options.wsPort ?? 6080;
    const spawnImpl = this.options.spawn ?? nativeSpawn;
    const sleep = this.options.sleep ?? defaultSleep;
    const waitForPort = this.options.waitForPort ?? waitForTcpPort;
    const sessionId = randomBytes(16).toString("hex");
    const processes: ChildProcess[] = [];

    try {
      const xvfb = spawnImpl("Xvfb", [display, "-screen", "0", "1280x800x24", "+extension", "RANDR"], {
        stdio: "ignore",
      });
      processes.push(xvfb);
      await ensureStarted(xvfb, "Xvfb", sleep);

      const x11vnc = spawnImpl(
        "x11vnc",
        ["-display", display, "-nopw", "-forever", "-shared", "-rfbport", String(vncPort), "-quiet", "-repeat"],
        { stdio: "ignore" },
      );
      processes.push(x11vnc);
      await ensureStarted(x11vnc, "x11vnc", sleep);
      await waitForPort(vncPort, "127.0.0.1", 30_000);

      const websockify = spawnImpl(
        "websockify",
        [String(wsPort), `127.0.0.1:${vncPort}`],
        { stdio: "ignore" },
      );
      processes.push(websockify);
      await ensureStarted(websockify, "websockify", sleep);
      await waitForPort(wsPort, "127.0.0.1", 30_000);

      this.active = { sessionId, display, wsPort, processes };
      for (const proc of processes) {
        if (typeof proc.once === "function") {
          proc.once("exit", () => {
            if (this.active?.sessionId === sessionId) {
              void this.stop(sessionId);
            }
          });
        }
      }
    } catch (error) {
      await killProcesses(processes);
      throw error;
    }

    return { sessionId, display, wsPort };
  }

  public getStatus(): { running: boolean; sessionId?: string } {
    if (!this.active) return { running: false };
    return { running: true, sessionId: this.active.sessionId };
  }

  public getSession(sessionId: string): VncSessionHandle | null {
    if (!this.active || this.active.sessionId !== sessionId) return null;
    return {
      sessionId: this.active.sessionId,
      display: this.active.display,
      wsPort: this.active.wsPort,
    };
  }

  public async stop(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    await killProcesses(this.active.processes);
    this.active = null;
  }

  public async stopAny(): Promise<void> {
    if (this.active) await this.stop(this.active.sessionId);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureStarted(
  proc: ChildProcess,
  name: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let startupError: Error | null = null;

  if (typeof proc.once === "function") {
    proc.once("error", (error) => {
      startupError = new Error(`${name} 启动失败: ${error.message}`);
    });
    proc.once("exit", (code, signal) => {
      startupError = new Error(`${name} 过早退出: code=${code ?? "null"}, signal=${signal ?? "null"}`);
    });
  }

  await sleep(500);
  if (startupError) throw startupError;
}

function waitForTcpPort(port: number, host: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | null = null;
    let socket: Socket | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (socket) socket.destroy();
      socket = null;
    };

    const retry = () => {
      socket = new Socket();
      socket.once("connect", () => {
        cleanup();
        resolve();
      });
      socket.once("error", () => {
        socket?.destroy();
        socket = null;
        if (Date.now() - startedAt >= timeoutMs) {
          cleanup();
          reject(new Error(`等待 ${host}:${port} 就绪超时`));
          return;
        }
        timer = setTimeout(retry, 100);
      });
      socket.connect(port, host);
    };

    retry();
  });
}

async function killProcesses(processes: ChildProcess[]): Promise<void> {
  for (const proc of processes.slice().reverse()) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}
