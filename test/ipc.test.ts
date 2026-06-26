import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { Store } from "../src/daemon/store.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, Message, PingResult, RoleSummary } from "../src/protocol.ts";

const tmp = join(tmpdir(), `agvsr-test-${randomUUID()}`);
const sock = `${tmp}.sock`;
const store = `${tmp}.sqlite`;
const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  design: { adapter: claude-code, model: claude-sonnet-4-6 }
  implementation: { adapter: codex, model: gpt-5-codex }
  qa: { adapter: agy, model: gemini-3-pro }
`);

let daemon: Daemon;
const dispatches: TurnDispatch[] = [];
let seq = 0;

async function waitForDispatches(n: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (dispatches.length >= n) return;
    await Bun.sleep(5);
  }
  throw new Error(`expected ${n} dispatches, got ${dispatches.length}`);
}

beforeAll(async () => {
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  daemon = await startDaemon({
    endpoint: sock,
    storeFile: store,
    team: TEAM,
    turnRunner: async (dispatch) => {
      dispatches.push(dispatch);
      return {
        events: [{ kind: "result", ok: true, text: `ok ${dispatch.role}` }],
        outcome: {
          sessionId: `${dispatch.role}-${++seq}`,
          finalText: `ok ${dispatch.role}`,
          exitCode: 0,
        },
      };
    },
  });
});

afterAll(async () => {
  await daemon.close();
  for (const f of [sock, store, `${store}-wal`, `${store}-shm`]) {
    try {
      rmSync(f);
    } catch {}
  }
});

describe("CLI <-> daemon over local IPC", () => {
  it("responds to ping", async () => {
    const c = await Client.connect(sock);
    const res = await c.request<PingResult>("ping");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.pong).toBe(true);
    c.close();
  });

  it("creates, dispatches and lists jobs (persisted by the daemon)", async () => {
    const c = await Client.connect(sock);
    const before = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "do a thing",
      cwd: "/repo",
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.result.job.id : "";

    await waitForDispatches(before + 1);
    const first = dispatches.at(-1)!;
    expect(first.role).toBe("supervisor");
    expect(first.job.id).toBe(id);
    expect(first.message).toBe("do a thing");
    expect(first.sessionId).toBeNull();
    expect(first.systemPrompt).toContain("supervisor");
    expect(first.env.AGVSR_ALLOWED!.split(",").sort()).toEqual(
      ["design", "implementation", "qa", "user"].sort(),
    );

    const got = await c.request<{ job: Job }>("job.get", { id });
    expect(got.ok && got.result.job.goal).toBe("do a thing");

    const list = await c.request<{ jobs: Job[] }>("job.list");
    expect(list.ok && list.result.jobs.some((j) => j.id === id)).toBe(true);
    c.close();
  });

  it("routes allowed messages and resumes the target session", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "route me", cwd: "/repo" });
    expect(created.ok).toBe(true);
    await waitForDispatches(beforeCreate + 1);
    const job = created.ok ? created.result.job : null;
    expect(job).toBeTruthy();

    const beforeSend = dispatches.length;
    const sent = await c.request<{ queued: true; message: Message }>("msg.send", {
      from: "supervisor",
      job_id: job!.id,
      to: "implementation",
      body: "please implement",
      refs: ["docs/design.md"],
    });
    expect(sent.ok).toBe(true);
    await waitForDispatches(beforeSend + 1);
    const last = dispatches.at(-1)!;
    expect(last.role).toBe("implementation");
    expect(last.message).toBe("please implement");
    expect(last.env.AGVSR_ALLOWED!).toBe("supervisor");
    expect(sent.ok && JSON.parse(sent.result.message.refs!)).toEqual(["docs/design.md"]);

    const logs = await c.request<{ messages: Message[] }>("msg.list", {
      job_id: job!.id,
      mark_read: true,
    });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.body === "please implement")).toBe(true);

    const readLogs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job!.id });
    expect(readLogs.ok).toBe(true);
    if (!readLogs.ok) throw new Error("msg.list failed");
    const lastReadAt = logs.result.messages.at(-1)!.created_at;
    expect(readLogs.result.messages.every((m) => m.read_at || m.created_at > lastReadAt)).toBe(
      true,
    );
    c.close();
  });

  it("rejects disallowed worker-to-worker messages", async () => {
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "bad route",
      cwd: "/repo",
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    const res = await c.request("msg.send", {
      from: "implementation",
      job_id: jobId,
      to: "qa",
      body: "skip the hub",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("forbidden");
    c.close();
  });

  it("routes escalation to the supervisor", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "needs escalation",
      cwd: "/repo",
    });
    expect(created.ok).toBe(true);
    await waitForDispatches(beforeCreate + 1);
    const jobId = created.ok ? created.result.job.id : "";

    const beforeEscalate = dispatches.length;
    const res = await c.request<{ queued: true; message: Message }>("msg.escalate", {
      from: "implementation",
      job_id: jobId,
      reason: "permission denied",
    });
    expect(res.ok).toBe(true);
    await waitForDispatches(beforeEscalate + 1);
    const last = dispatches.at(-1)!;
    expect(last.role).toBe("supervisor");
    expect(last.sessionId).toMatch(/^supervisor-/);
    expect(last.systemPrompt).toBe("");
    expect(last.message).toContain("permission denied");
    expect(res.ok && res.result.message.kind).toBe("escalation");
    c.close();
  });

  it("routes non-timeout worker failures to supervisor instead of failing the job", async () => {
    const base = join(tmpdir(), `agvsr-tier1-test-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        if (dispatch.role === "implementation") {
          return {
            events: [{ kind: "result", ok: false, text: "boom" }],
            outcome: { sessionId: "impl-session", finalText: "boom", exitCode: 2 },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: dispatch.role, exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", { goal: "tier1", cwd: "/repo" });
    expect(created.ok).toBe(true);
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    const jobId = created.ok ? created.result.job.id : "";

    const sent = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "please fail",
    });
    expect(sent.ok).toBe(true);
    for (let i = 0; i < 50 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
      await Bun.sleep(5);
    }

    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("running");
    expect(seen.at(-1)!.role).toBe("supervisor");
    expect(seen.at(-1)!.message).toContain("implementation turn failed");
    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some((m) => m.kind === "escalation" && m.from_role === "daemon"),
    ).toBe(true);

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("interrupts stale running jobs on daemon start", async () => {
    const base = join(tmpdir(), `agvsr-interrupt-test-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const setup = new Store(db);
    const stale = setup.createJob("stale job", "/repo");
    setup.close();

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      turnRunner: async () => {
        throw new Error("should not dispatch stale jobs");
      },
    });
    const c = await Client.connect(sockLocal);
    const got = await c.request<{ job: Job }>("job.get", { id: stale.id });
    expect(got.ok && got.result.job.status).toBe("interrupted");
    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: stale.id });
    expect(logs.ok && logs.result.messages.some((m) => m.from_role === "daemon")).toBe(true);

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("persists role sessions across daemon restarts", async () => {
    const base = join(tmpdir(), `agvsr-session-test-${randomUUID()}`);
    const sock1 = `${base}-1.sock`;
    const sock2 = `${base}-2.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    let localSeq = 0;
    const { startDaemon } = await import("../src/daemon/daemon.ts");

    const firstDaemon = await startDaemon({
      endpoint: sock1,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: {
            sessionId: `${dispatch.role}-persisted-${++localSeq}`,
            finalText: dispatch.role,
            exitCode: 0,
          },
        };
      },
    });
    const firstClient = await Client.connect(sock1);
    const created = await firstClient.request<{ job: Job }>("job.create", {
      goal: "persist sessions",
      cwd: "/repo",
    });
    expect(created.ok).toBe(true);
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    firstClient.close();
    await firstDaemon.close();

    const jobId = created.ok ? created.result.job.id : "";
    const secondDaemon = await startDaemon({
      endpoint: sock2,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: dispatch.sessionId, finalText: dispatch.role, exitCode: 0 },
        };
      },
    });
    const secondClient = await Client.connect(sock2);
    const beforeEscalate = seen.length;
    const escalated = await secondClient.request("msg.escalate", {
      from: "implementation",
      job_id: jobId,
      reason: "resume supervisor",
    });
    expect(escalated.ok).toBe(true);
    for (let i = 0; i < 50 && seen.length < beforeEscalate + 1; i++) await Bun.sleep(5);

    const resumed = seen.at(-1)!;
    expect(resumed.role).toBe("supervisor");
    expect(resumed.sessionId).toBe("supervisor-persisted-1");
    expect(resumed.systemPrompt).toBe("");

    secondClient.close();
    await secondDaemon.close();
    for (const f of [sock1, sock2, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("rejects an empty goal", async () => {
    const c = await Client.connect(sock);
    const res = await c.request("job.create", { goal: "  ", cwd: "/repo" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_request");
    c.close();
  });

  it("returns the configured team roles", async () => {
    const c = await Client.connect(sock);
    const res = await c.request<{ roles: RoleSummary[] }>("team.get");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const names = res.result.roles.map((r) => r.name);
      expect(names).toContain("supervisor");
      expect(names).toContain("qa");
    }
    c.close();
  });
});
