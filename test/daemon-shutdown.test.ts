import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client, EndpointInUseError, serve } from "../src/ipc/transport.ts";
import { waitForEndpointFree } from "../src/cli/agvsr.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Request, Response } from "../src/protocol.ts";
import type { Job } from "../src/protocol.ts";
import type { TurnDispatch } from "../src/daemon/daemon.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
`);

const echo = (req: Request): Response => ({
  id: req.id,
  type: "response",
  ok: true,
  result: { pong: true },
});

function tmpBase(tag: string): string {
  return join(tmpdir(), `agvsr-${tag}-${randomUUID()}`);
}

describe("endpoint ownership (fix A)", () => {
  it("refuses to take over an endpoint another server is still listening on", async () => {
    const endpoint = `${tmpBase("endpoint")}.sock`;
    const first = await serve(endpoint, echo);

    // The whole point: a second daemon must fail loudly instead of unlinking the
    // live socket and leaving the first process alive but unreachable.
    await expect(serve(endpoint, echo)).rejects.toThrow(EndpointInUseError);

    // The original is untouched and still serving.
    const c = await Client.connect(endpoint);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
    await first.close();
  });

  it("still clears a stale socket file left by a crashed daemon", async () => {
    const endpoint = `${tmpBase("stale")}.sock`;
    // A socket path with nothing behind it: refuses connections, so it is safe
    // to unlink — this is the case the original unconditional unlink existed for.
    writeFileSync(endpoint, "");
    expect(existsSync(endpoint)).toBe(true);

    const server = await serve(endpoint, echo);
    const c = await Client.connect(endpoint);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
    await server.close();
  });

  it("frees the endpoint on close so the next daemon can bind it", async () => {
    const endpoint = `${tmpBase("rebind")}.sock`;
    const first = await serve(endpoint, echo);
    await first.close();

    const second = await serve(endpoint, echo);
    const c = await Client.connect(endpoint);
    expect((await c.request("ping")).ok).toBe(true);
    c.close();
    await second.close();
  });
});

describe("waitForEndpointFree (restart sequencing)", () => {
  const noop = async () => {};

  it("returns true as soon as nothing answers", async () => {
    const free = await waitForEndpointFree("/nonexistent/agvsr.sock", {
      sleep: noop,
      timeoutMs: 1000,
    });
    expect(free).toBe(true);
  });

  it("returns false while a daemon is still listening, rather than racing it", async () => {
    const endpoint = `${tmpBase("busy")}.sock`;
    const server = await serve(endpoint, echo);
    const free = await waitForEndpointFree(endpoint, { sleep: noop, timeoutMs: 150, pollMs: 10 });
    expect(free).toBe(false);
    await server.close();
  });

  it("returns true once the daemon actually goes away", async () => {
    const endpoint = `${tmpBase("closing")}.sock`;
    const server = await serve(endpoint, echo);
    setTimeout(() => void server.close(), 50);
    expect(await waitForEndpointFree(endpoint, { timeoutMs: 5000, pollMs: 20 })).toBe(true);
  });
});

/** Daemon whose turns hang until their AbortSignal fires. */
async function makeHangingDaemon(options: { shutdownDrainMs: number }) {
  const base = tmpBase("shutdown");
  const sock = `${base}.sock`;
  const db = `${base}.sqlite`;
  const repo = `${base}-repo`;
  mkdirSync(repo, { recursive: true });
  const started: TurnDispatch[] = [];
  let aborted = 0;

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: TEAM,
    interruptRunningJobsOnStart: false,
    shutdownDrainMs: options.shutdownDrainMs,
    turnRunner: (d: TurnDispatch) =>
      new Promise((resolve) => {
        started.push(d);
        d.signal?.addEventListener("abort", () => {
          aborted++;
          resolve({
            events: [],
            outcome: { sessionId: null, finalText: "", exitCode: 143 },
          });
        });
      }),
  });
  return { daemon, sock, db, repo, started, abortedCount: () => aborted };
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

describe("bounded shutdown drain (fix B)", () => {
  it("stops listening and aborts a turn that outlives the drain budget", async () => {
    const h = await makeHangingDaemon({ shutdownDrainMs: 100 });
    const c = await Client.connect(h.sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "hang", cwd: h.repo });
    expect(created.ok).toBe(true);
    for (let i = 0; i < 100 && h.started.length < 1; i++) await Bun.sleep(5);
    expect(h.started.length).toBe(1); // a turn is in flight and will never finish on its own
    c.close();

    const t0 = Date.now();
    await h.daemon.close();
    const elapsed = Date.now() - t0;

    // Previously this awaited the dispatch first, so it would have blocked until
    // the turn's hard timeout (1h by default) instead of the drain budget.
    expect(elapsed).toBeLessThan(5000);
    // The straggler was aborted rather than orphaned.
    expect(h.abortedCount()).toBe(1);
    // And the endpoint is genuinely released.
    await expect(Client.connect(h.sock)).rejects.toThrow();

    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });

  it("refuses to queue follow-up turns once shutdown has begun", async () => {
    // Several result paths enqueue a follow-up turn (the worker no-route escalation,
    // the supervisor idle nudge). One queued after the drain snapshot would run past
    // store.close() and throw "Cannot use a closed database" from a detached promise.
    const base = tmpBase("closing");
    const sock = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repo = `${base}-repo`;
    mkdirSync(repo, { recursive: true });

    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const daemon = await startDaemon({
      endpoint: sock,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      shutdownDrainMs: 5000,
      turnRunner: async (d: TurnDispatch) => {
        calls++;
        await gate;
        // Text but no routing: normally this queues a nudge turn.
        return {
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "thinking out loud", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sock);
    await c.request<{ job: Job }>("job.create", { goal: "queues a follow-up", cwd: repo });
    for (let i = 0; i < 100 && calls < 1; i++) await Bun.sleep(5);
    expect(calls).toBe(1);
    c.close();

    const closed = daemon.close(); // sets the closing flag, then drains
    release();
    await closed;

    await Bun.sleep(100);
    expect(calls).toBe(1); // the nudge turn was refused, not queued behind the drain
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("closes immediately when nothing is in flight", async () => {
    const h = await makeHangingDaemon({ shutdownDrainMs: 5000 });
    const t0 = Date.now();
    await h.daemon.close();
    // No pending dispatches means the drain budget is never consulted.
    expect(Date.now() - t0).toBeLessThan(2000);
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });
});

describe("daemon.stop exits the process (fix D)", () => {
  async function makeDaemon(opts: { exitOnStop?: boolean }) {
    const base = tmpBase("stopexit");
    const sock = `${base}.sock`;
    const db = `${base}.sqlite`;
    const exits: number[] = [];
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const daemon = await startDaemon({
      endpoint: sock,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      shutdownDrainMs: 100,
      exitOnStop: opts.exitOnStop,
      exit: (code: number) => exits.push(code),
      turnRunner: async (d: TurnDispatch) => ({
        events: [],
        outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
      }),
    });
    return { daemon, sock, db, exits };
  }

  it("answers the stop request before tearing the connection down", async () => {
    const h = await makeDaemon({ exitOnStop: true });
    const c = await Client.connect(h.sock);
    // The reply is written on the very socket close() is about to end, so a
    // shutdown scheduled too eagerly would drop it and hang the CLI.
    const res = await c.request("daemon.stop");
    expect(res.ok).toBe(true);
    c.close();

    for (let i = 0; i < 100 && h.exits.length === 0; i++) await Bun.sleep(10);
    expect(h.exits).toEqual([0]);
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`);
  });

  it("does not exit for embedders and tests that never opted in", async () => {
    const h = await makeDaemon({});
    const c = await Client.connect(h.sock);
    expect((await c.request("daemon.stop")).ok).toBe(true);
    c.close();
    await Bun.sleep(300);
    expect(h.exits).toEqual([]);
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`);
  });
});
