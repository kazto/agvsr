import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, JobRuntime } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

let daemon: Daemon | null = null;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  while (cleanups.length) cleanups.pop()!();
});

async function getRuntime(c: Client, id: string): Promise<JobRuntime> {
  const res = await c.request<{ job: Job; runtime: JobRuntime }>("job.get", { id });
  if (!res.ok) throw new Error(res.error.message);
  return res.result.runtime;
}

describe("job runtime (execution-state visibility, B)", () => {
  it("reports in_flight while a turn runs, then idle once it finishes", async () => {
    const tmp = join(tmpdir(), `agvsr-runtime-${randomUUID()}`);
    const sock = `${tmp}.sock`;
    const store = `${tmp}.sqlite`;
    const repo = `${tmp}-repo`;
    mkdirSync(repo, { recursive: true });
    cleanups.push(() => {
      for (const f of [sock, store, `${store}-wal`, `${store}-shm`, repo]) {
        try {
          rmSync(f, { recursive: true });
        } catch {}
      }
    });

    // Gate lets the test hold the supervisor turn open to observe in_flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: sock,
      storeFile: store,
      team: TEAM,
      turnRunner: async () => {
        await gate;
        return {
          events: [{ kind: "result", ok: true, text: "ok" }],
          outcome: { sessionId: "s1", finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "watch me", cwd: repo });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.result.job.id : "";

    // While the turn is gated, the job reports an in-flight supervisor turn.
    let rt: JobRuntime | null = null;
    for (let i = 0; i < 100; i++) {
      rt = await getRuntime(c, id);
      if (rt.in_flight) break;
      await Bun.sleep(5);
    }
    expect(rt!.in_flight).toBe(true);
    expect(rt!.active_roles).toEqual(["supervisor"]);

    // Release the turn; once dispatch settles, the job is idle (no in-flight turn).
    release();
    for (let i = 0; i < 100; i++) {
      rt = await getRuntime(c, id);
      if (!rt.in_flight) break;
      await Bun.sleep(5);
    }
    expect(rt!.in_flight).toBe(false);
    expect(rt!.active_roles).toEqual([]);
    expect(rt!.last_activity_at).not.toBeNull();
    expect(rt!.idle_ms).not.toBeNull();
    expect(rt!.idle_ms!).toBeGreaterThanOrEqual(0);

    c.close();
  });
});
