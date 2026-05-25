import assert from "node:assert/strict";
import test from "node:test";

import { VncSupervisor } from "../../src/vnc/supervisor.js";

class FakeProcess {
  public killed = false;
  public on(_event: string, _cb: (...args: unknown[]) => void): this { return this; }
  public kill(): void { this.killed = true; }
}

test("VncSupervisor refuses concurrent start", async () => {
  const supervisor = new VncSupervisor({
    display: ":99",
    vncPort: 5900,
    wsPort: 6080,
    spawn: () => new FakeProcess() as unknown as any,
    sleep: async () => {},
  });

  const s1 = await supervisor.start();
  await assert.rejects(() => supervisor.start(), /already running/);
  await supervisor.stop(s1.sessionId);
});

test("VncSupervisor cleans up children on stop", async () => {
  const procs: FakeProcess[] = [];
  const supervisor = new VncSupervisor({
    display: ":99",
    vncPort: 5900,
    wsPort: 6080,
    spawn: () => {
      const p = new FakeProcess();
      procs.push(p);
      return p as unknown as any;
    },
    sleep: async () => {},
  });

  const session = await supervisor.start();
  await supervisor.stop(session.sessionId);
  assert.ok(procs.every((p) => p.killed));
});
