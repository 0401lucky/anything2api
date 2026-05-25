import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface VncSupervisorOptions {
  display?: string;
  vncPort?: number;
  wsPort?: number;
  spawn?: typeof nativeSpawn;
  sleep?: (ms: number) => Promise<void>;
}

export interface VncSessionHandle {
  sessionId: string;
  display: string;
  wsPort: number;
}

export class VncSupervisor {
  private active: { sessionId: string; processes: ChildProcess[] } | null = null;

  public constructor(private readonly options: VncSupervisorOptions = {}) {}

  public async start(): Promise<VncSessionHandle> {
    if (this.active) throw new Error("VNC already running");

    const display = this.options.display ?? ":99";
    const vncPort = this.options.vncPort ?? 5900;
    const wsPort = this.options.wsPort ?? 6080;
    const spawnImpl = this.options.spawn ?? nativeSpawn;
    const sleep = this.options.sleep ?? defaultSleep;

    const xvfb = spawnImpl("Xvfb", [display, "-screen", "0", "1280x800x24"], { stdio: "ignore" });
    await sleep(500);
    const x11vnc = spawnImpl(
      "x11vnc",
      ["-display", display, "-nopw", "-forever", "-shared", "-rfbport", String(vncPort), "-quiet"],
      { stdio: "ignore" },
    );
    await sleep(500);
    const websockify = spawnImpl(
      "websockify",
      [String(wsPort), `127.0.0.1:${vncPort}`, "--web", process.env.NOVNC_DIR ?? "/usr/share/novnc"],
      { stdio: "ignore" },
    );
    await sleep(500);

    const sessionId = randomBytes(16).toString("hex");
    this.active = { sessionId, processes: [xvfb, x11vnc, websockify] };

    return { sessionId, display, wsPort };
  }

  public getStatus(): { running: boolean; sessionId?: string } {
    if (!this.active) return { running: false };
    return { running: true, sessionId: this.active.sessionId };
  }

  public async stop(sessionId: string): Promise<void> {
    if (!this.active || this.active.sessionId !== sessionId) return;
    for (const proc of this.active.processes) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.active = null;
  }

  public async stopAny(): Promise<void> {
    if (this.active) await this.stop(this.active.sessionId);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
