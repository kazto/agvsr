import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
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
    // After turn completes, turn-timing maps should be cleared (AC-10).
    expect(rt!.turn_started_at).toBeUndefined();
    expect(rt!.hard_remaining_ms).toBeUndefined();
    expect(rt!.last_progress_at).toBeUndefined();
    expect(rt!.idle_since_progress_ms).toBeUndefined();

    c.close();
  });
});

// ---------------------------------------------------------------------------
// AC-8: hard_remaining_ms and AC-9: last_progress_at in status (Tier 1+2)
// ---------------------------------------------------------------------------

describe("turn timeout runtime visibility (AC-8, AC-9, AC-10)", () => {
  it("shows hard_remaining_ms and last_progress_at while in-flight", async () => {
    const tmp = join(tmpdir(), `agvsr-timeout-rt-${randomUUID()}`);
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

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let progressCalls = 0;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: sock,
      storeFile: store,
      team: parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model, hard_timeout_ms: 120000, idle_timeout_ms: 60000 }
`),
      turnRunner: async (dispatch: TurnDispatch) => {
        // Simulate one progress event then hold.
        dispatch.onProgress?.();
        progressCalls++;
        await gate;
        return {
          events: [{ kind: "result", ok: true, text: "ok" }],
          outcome: { sessionId: "s1", finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "timing test", cwd: repo });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.result.job.id : "";

    // Wait for in-flight and for onProgress to be called.
    let rt: JobRuntime | null = null;
    for (let i = 0; i < 100; i++) {
      rt = await getRuntime(c, id);
      if (rt.in_flight && progressCalls > 0) break;
      await Bun.sleep(5);
    }

    expect(rt!.in_flight).toBe(true);

    // AC-8: hard_remaining_ms should be present and positive.
    expect(rt!.hard_remaining_ms).toBeTruthy();
    const remaining = rt!.hard_remaining_ms!["supervisor"];
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(120000);

    // AC-8: turn_started_at should be present and valid ISO string.
    expect(rt!.turn_started_at).toBeTruthy();
    expect(rt!.turn_started_at!["supervisor"]).toMatch(/^\d{4}-/);

    // AC-9: last_progress_at should be present (onProgress was called).
    expect(rt!.last_progress_at).toBeTruthy();
    expect(rt!.last_progress_at!["supervisor"]).toMatch(/^\d{4}-/);
    expect(rt!.idle_since_progress_ms).toBeTruthy();
    expect(rt!.idle_since_progress_ms!["supervisor"]).toBeGreaterThanOrEqual(0);

    // Release the turn and wait for it to finish.
    release();
    for (let i = 0; i < 100; i++) {
      rt = await getRuntime(c, id);
      if (!rt.in_flight) break;
      await Bun.sleep(5);
    }

    // AC-10: after turn completes, timing maps are cleared.
    expect(rt!.in_flight).toBe(false);
    expect(rt!.hard_remaining_ms).toBeUndefined();
    expect(rt!.turn_started_at).toBeUndefined();
    expect(rt!.last_progress_at).toBeUndefined();
    expect(rt!.idle_since_progress_ms).toBeUndefined();

    c.close();
  });
});
