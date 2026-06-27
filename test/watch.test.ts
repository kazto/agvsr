import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, PushFrame } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
`);

const tmp = join(tmpdir(), `agvsr-watch-suite-${randomUUID()}`);
const sock = `${tmp}.sock`;
const store = `${tmp}.sqlite`;
const repo = `${tmp}-repo`;

let daemon: Daemon;
const dispatches: TurnDispatch[] = [];

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  daemon = await startDaemon({
    endpoint: sock,
    storeFile: store,
    team: TEAM,
    interruptRunningJobsOnStart: false,
    turnRunner: async (dispatch) => {
      dispatches.push(dispatch);
      return {
        events: [{ kind: "result", ok: true, text: dispatch.role }],
        outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
      };
    },
  });
});

afterAll(async () => {
  await daemon.close();
  for (const f of [sock, store, `${store}-wal`, `${store}-shm`, repo]) {
    try {
      rmSync(f, { recursive: true });
    } catch {}
  }
});

describe("agvsr watch — cross-job message streaming", () => {
  it("single client receives push frames from two simultaneously watched jobs", async () => {
    const c = await Client.connect(sock);

    const j1 = await c.request<{ job: Job }>("job.create", { goal: "watch job one", cwd: repo });
    const j2 = await c.request<{ job: Job }>("job.create", { goal: "watch job two", cwd: repo });
    expect(j1.ok).toBe(true);
    expect(j2.ok).toBe(true);
    if (!j1.ok || !j2.ok) throw new Error("job.create failed");

    const jobId1 = j1.result.job.id;
    const jobId2 = j2.result.job.id;

    const pushed: PushFrame[] = [];
    c.onPush = (f) => pushed.push(f);

    // Simulate what `agvsr watch` does: subscribe to each job individually.
    const w1 = await c.request("msg.watch", { job_id: jobId1 });
    const w2 = await c.request("msg.watch", { job_id: jobId2 });
    expect(w1.ok).toBe(true);
    expect(w2.ok).toBe(true);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId1,
      to: "implementation",
      body: "message for job one",
    });
    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId2,
      to: "implementation",
      body: "message for job two",
    });

    for (let i = 0; i < 50 && pushed.length < 2; i++) await Bun.sleep(5);

    const seenJobIds = new Set(pushed.map((f) => f.data.job_id));
    expect(seenJobIds.has(jobId1)).toBe(true);
    expect(seenJobIds.has(jobId2)).toBe(true);
    expect(pushed.find((f) => f.data.body === "message for job one")).toBeTruthy();
    expect(pushed.find((f) => f.data.body === "message for job two")).toBeTruthy();

    c.close();
  });

  it("messages from an unwatched job do not appear in the stream", async () => {
    const c = await Client.connect(sock);

    const j1 = await c.request<{ job: Job }>("job.create", { goal: "watched", cwd: repo });
    const j2 = await c.request<{ job: Job }>("job.create", { goal: "not watched", cwd: repo });
    expect(j1.ok && j2.ok).toBe(true);
    if (!j1.ok || !j2.ok) throw new Error();

    const pushed: PushFrame[] = [];
    c.onPush = (f) => pushed.push(f);

    // Subscribe to job1 only.
    await c.request("msg.watch", { job_id: j1.result.job.id });

    await c.request("msg.send", {
      from: "supervisor",
      job_id: j2.result.job.id,
      to: "implementation",
      body: "should not arrive",
    });

    await Bun.sleep(30);
    expect(pushed.length).toBe(0);

    // Message for the watched job should arrive.
    await c.request("msg.send", {
      from: "supervisor",
      job_id: j1.result.job.id,
      to: "implementation",
      body: "should arrive",
    });
    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(5);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]!.data.body).toBe("should arrive");

    c.close();
  });

  it("subscribing to a newly created job after initial poll also streams its messages", async () => {
    const base = join(tmpdir(), `agvsr-watch-latejob-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const d = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => ({
        events: [{ kind: "result", ok: true, text: dispatch.role }],
        outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
      }),
    });

    const c = await Client.connect(sockLocal);
    const pushed: PushFrame[] = [];
    c.onPush = (f) => pushed.push(f);

    // Initial poll: no running jobs yet.
    const initial = await c.request<{ jobs: Job[] }>("job.list");
    expect(initial.ok).toBe(true);

    // A new job appears (simulating what the poll interval would find).
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "late job",
      cwd: repoLocal,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();

    // Watch picks it up on the next poll — simulate by subscribing now.
    const watchRes = await c.request("msg.watch", { job_id: created.result.job.id });
    expect(watchRes.ok).toBe(true);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: created.result.job.id,
      to: "implementation",
      body: "hello late job",
    });

    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(5);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]!.data.body).toBe("hello late job");
    expect(pushed[0]!.data.job_id).toBe(created.result.job.id);

    c.close();
    await d.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
      try {
        rmSync(f, { recursive: true });
      } catch {}
    }
  });

  it("existing messages are available via msg.list before subscribing to push frames", async () => {
    const c = await Client.connect(sock);

    const created = await c.request<{ job: Job }>("job.create", {
      goal: "history job",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    // Send a message before any watch subscription (it will be in msg.list).
    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "pre-existing message",
    });

    // The watch flow: first list existing messages, then subscribe.
    const listRes = await c.request<{ messages: { id: string; body: string }[] }>("msg.list", {
      job_id: jobId,
    });
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) throw new Error();
    expect(listRes.result.messages.some((m) => m.body === "pre-existing message")).toBe(true);

    // Then subscribe and verify new messages still arrive.
    const pushed: PushFrame[] = [];
    c.onPush = (f) => pushed.push(f);
    await c.request("msg.watch", { job_id: jobId });

    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "post-subscribe message",
    });

    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(5);
    expect(pushed.some((f) => f.data.body === "post-subscribe message")).toBe(true);

    c.close();
  });
});
