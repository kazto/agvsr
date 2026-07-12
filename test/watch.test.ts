import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import {
  formatRuntime,
  formatWatchHeartbeatLine,
  parsePollMs,
  renderWatchMessage,
} from "../src/cli/agvsr.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, JobRuntime, Message, PushFrame } from "../src/protocol.ts";

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
    expect(
      pushed.find((f) => f.event === "msg.new" && f.data.body === "message for job one"),
    ).toBeTruthy();
    expect(
      pushed.find((f) => f.event === "msg.new" && f.data.body === "message for job two"),
    ).toBeTruthy();

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
    const w0 = pushed[0]!;
    if (w0.event !== "msg.new") throw new Error("expected msg.new frame");
    expect(w0.data.body).toBe("should arrive");

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
    const late0 = pushed[0]!;
    if (late0.event !== "msg.new") throw new Error("expected msg.new frame");
    expect(late0.data.body).toBe("hello late job");
    expect(late0.data.job_id).toBe(created.result.job.id);

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
    expect(
      pushed.some((f) => f.event === "msg.new" && f.data.body === "post-subscribe message"),
    ).toBe(true);

    c.close();
  });
});

describe("agvsr watch — delimiter rendering", () => {
  const jobId = "1234567890abcdef";
  const shortId = jobId.slice(0, 8);

  const mkMsg = (over: Partial<Message> = {}): Message => ({
    id: randomUUID(),
    job_id: jobId,
    from_role: "supervisor",
    to_role: "implementation",
    kind: "message",
    body: "hello",
    refs: null,
    created_at: "2026-06-29T01:00:00.000Z",
    read_at: null,
    ...over,
  });

  // Mirror the watch case: a `printedMsg` flag drives the delimiter so a single
  // `---` appears before every message after the first, across both the backfill
  // (msg.list) and live (msg.new) paths that share `renderWatchMessage`.
  const renderStream = (msgs: Message[], tty = false): string => {
    let printedMsg = false;
    const out: string[] = [];
    for (const m of msgs) {
      out.push(renderWatchMessage(m.job_id, m, { withDelimiter: printedMsg, tty }));
      printedMsg = true;
    }
    return out.join("\n");
  };

  it("emits no delimiter before the first message", () => {
    const rendered = renderWatchMessage(jobId, mkMsg({ body: "first" }), { withDelimiter: false });
    const lines = rendered.split("\n");
    expect(lines[0]).toContain(`[${shortId}]`);
    expect(lines[0]).toContain("message supervisor -> implementation");
    expect(lines[1]).toBe("first");
    expect(lines[2]).toBe("");
    expect(rendered).not.toContain("---");
  });

  it("inserts exactly one delimiter between consecutive messages (backfill + live)", () => {
    const rendered = renderStream([
      mkMsg({ body: "backfill-1" }),
      mkMsg({ body: "backfill-2" }),
      mkMsg({ body: "live-1" }),
    ]);
    const lines = rendered.split("\n");

    // Two delimiters: before backfill-2 and before live-1, never before backfill-1.
    expect(lines.filter((l) => l === "---")).toHaveLength(2);

    const i1 = lines.indexOf("backfill-1");
    const i2 = lines.indexOf("backfill-2");
    const i3 = lines.indexOf("live-1");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);

    // Delimiter sits two lines above each subsequent body (---, header, body).
    expect(lines[i2 - 2]).toBe("---");
    expect(lines[i3 - 2]).toBe("---");
    expect(lines[i1 - 1] ?? "").not.toBe("---");
  });

  it("preserves header, refs, and trailing blank-line formatting", () => {
    const rendered = renderWatchMessage(
      jobId,
      mkMsg({ body: "with refs", refs: "src/cli/agvsr.ts" }),
      {
        withDelimiter: true,
      },
    );
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toContain(`[${shortId}]`);
    expect(lines[1]).toContain("message supervisor -> implementation");
    expect(lines[1]).toContain("refs=src/cli/agvsr.ts");
    expect(lines[2]).toBe("with refs");
    expect(lines[3]).toBe("");
  });

  it("dims the delimiter only when stdout is a TTY", () => {
    const plain = renderWatchMessage(jobId, mkMsg(), { withDelimiter: true, tty: false });
    const tty = renderWatchMessage(jobId, mkMsg(), { withDelimiter: true, tty: true });
    expect(plain.split("\n")[0]).toBe("---");
    expect(tty.split("\n")[0]).toBe("\x1b[2m---\x1b[0m");
  });
});

describe("parsePollMs — --poll argument validation", () => {
  it("returns 2000 when no value is supplied", () => {
    expect(parsePollMs(undefined)).toBe(2000);
  });

  it("accepts valid positive numbers and returns them as-is above the minimum", () => {
    expect(parsePollMs("2000")).toBe(2000);
    expect(parsePollMs("5000")).toBe(5000);
    expect(parsePollMs("500")).toBe(500);
  });

  it("clamps values below 500 ms to 500", () => {
    expect(parsePollMs("1")).toBe(500);
    expect(parsePollMs("100")).toBe(500);
    expect(parsePollMs("499")).toBe(500);
  });

  it("throws RangeError for non-numeric strings", () => {
    expect(() => parsePollMs("abc")).toThrow(RangeError);
    expect(() => parsePollMs("NaN")).toThrow(RangeError);
    expect(() => parsePollMs("")).toThrow(RangeError);
    expect(() => parsePollMs("2s")).toThrow(RangeError);
  });

  it("throws RangeError for zero and negative values", () => {
    expect(() => parsePollMs("0")).toThrow(RangeError);
    expect(() => parsePollMs("-1")).toThrow(RangeError);
    expect(() => parsePollMs("-500")).toThrow(RangeError);
  });

  it("throws RangeError for Infinity", () => {
    expect(() => parsePollMs("Infinity")).toThrow(RangeError);
    expect(() => parsePollMs("-Infinity")).toThrow(RangeError);
  });

  it("error message names the bad value", () => {
    try {
      parsePollMs("bogus");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as Error).message).toContain("bogus");
    }
  });
});

describe("formatRuntime — status-consistent wording", () => {
  it("matches the status formatter output for running jobs", () => {
    const job = {
      id: "job-1",
      goal: "heartbeat",
      status: "running",
      cwd: "/repo",
      branch: null,
      worktree: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Job;
    const runtime = {
      in_flight: true,
      active_roles: ["supervisor"],
      last_activity_at: "2026-01-01T00:00:00.000Z",
      idle_ms: 4000,
      hard_remaining_ms: { supervisor: 5000 },
      idle_since_progress_ms: { supervisor: 2000 },
    } as JobRuntime;

    expect(formatRuntime(job, runtime)).toBe(
      " — working: supervisor, budget 5s left, last progress 2s ago, idle 4s",
    );
  });

  it("returns an empty suffix for terminal jobs", () => {
    const job = {
      id: "job-2",
      goal: "done",
      status: "done",
      cwd: "/repo",
      branch: null,
      worktree: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Job;
    const runtime = {
      in_flight: false,
      active_roles: [],
      last_activity_at: null,
      idle_ms: null,
    } as JobRuntime;

    expect(formatRuntime(job, runtime)).toBe("");
  });
});

describe("formatWatchHeartbeatLine — worker liveness rendering", () => {
  const shortId = (id: string): string => id.slice(0, 8);

  it("renders a working heartbeat that reuses the status wording", () => {
    const job = {
      id: "1234567890abcdef",
      goal: "heartbeat",
      status: "running",
      cwd: "/repo",
      branch: null,
      worktree: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Job;
    const runtime = {
      in_flight: true,
      active_roles: ["supervisor"],
      last_activity_at: "2026-01-01T00:00:00.000Z",
      idle_ms: 2000,
      hard_remaining_ms: { supervisor: 5000 },
      idle_since_progress_ms: { supervisor: 0 },
    } as JobRuntime;

    expect(formatWatchHeartbeatLine(job, runtime, shortId)).toBe(
      "~ heartbeat [12345678] running — working: supervisor, budget 5s left, last progress 0s ago, idle 2s",
    );
  });

  it("renders a possibly-stalled heartbeat for a job with no in-flight turn", () => {
    const job = {
      id: "1234567890abcdef",
      goal: "heartbeat",
      status: "running",
      cwd: "/repo",
      branch: null,
      worktree: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Job;
    const runtime = {
      in_flight: false,
      active_roles: [],
      last_activity_at: null,
      idle_ms: 1_380_000,
    } as JobRuntime;

    expect(formatWatchHeartbeatLine(job, runtime, shortId)).toBe(
      "~ heartbeat [12345678] running — no in-flight turn, idle 23m (possibly stalled)",
    );
  });

  it("renders a bare status line for terminal jobs (no runtime suffix)", () => {
    const job = {
      id: "1234567890abcdef",
      goal: "done",
      status: "done",
      cwd: "/repo",
      branch: null,
      worktree: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    } as Job;
    const runtime = {
      in_flight: false,
      active_roles: [],
      last_activity_at: null,
      idle_ms: null,
    } as JobRuntime;

    expect(formatWatchHeartbeatLine(job, runtime, shortId)).toBe("~ heartbeat [12345678] done");
  });
});
