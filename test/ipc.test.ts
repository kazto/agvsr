import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { Store } from "../src/daemon/store.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, Message, PingResult, PushFrame, RoleSummary } from "../src/protocol.ts";

const tmp = join(tmpdir(), `agvsr-test-${randomUUID()}`);
const sock = `${tmp}.sock`;
const store = `${tmp}.sqlite`;
const repo = `${tmp}-repo`;
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
  mkdirSync(repo, { recursive: true });
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
          finalText: "",
          exitCode: 0,
        },
      };
    },
  });
});

afterAll(async () => {
  await daemon.close();
  for (const f of [sock, store, `${store}-wal`, `${store}-shm`, repo]) {
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

  it("blocks premature and duplicate QA delegations", async () => {
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "qa routing guard",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    const premature = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "qa",
      body: "wait for the design",
    });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe("qa_design_required");

    const design = await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design complete",
    });
    expect(design.ok).toBe(true);
    const first = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "qa",
      body: "produce the consolidated test plan",
    });
    expect(first.ok).toBe(true);
    const duplicate = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "qa",
      body: "produce the consolidated test plan",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate_delegation");
    c.close();
  });

  it("creates, dispatches and lists jobs (persisted by the daemon)", async () => {
    const c = await Client.connect(sock);
    const before = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "do a thing",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.result.job.id : "";

    await waitForDispatches(before + 1);
    const first = dispatches.at(-1)!;
    expect(first.role).toBe("supervisor");
    expect(first.job.id).toBe(id);
    // The goal is delivered intact, behind the daemon's delegation status
    // block (D44) — only supervisor turns carry that prefix.
    expect(first.message).toContain("do a thing");
    expect(first.message).toContain("[agvsr delegation status]");
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
    const created = await c.request<{ job: Job }>("job.create", { goal: "route me", cwd: repo });
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
      cwd: repo,
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
      cwd: repo,
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

  it("gates supervisor->implementation until the human approves the design", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "gate me", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1); // initial supervisor turn

    // design hands its result to the supervisor -> the gate now engages.
    await Bun.sleep(2);
    const design = await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design: introduce a new dependency",
    });
    expect(design.ok).toBe(true);

    // supervisor tries to start implementation -> rejected, nothing dispatched/recorded.
    await Bun.sleep(2);
    const blocked = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "go implement",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("approval_required");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    const msgs = logs.ok ? logs.result.messages : [];
    expect(
      msgs.some(
        (m) => m.from_role === "daemon" && m.to_role === "user" && /approval/i.test(m.body),
      ),
    ).toBe(true);
    expect(msgs.some((m) => m.body === "go implement")).toBe(false);
    c.close();
  });

  it("unblocks implementation after approval and re-gates on a newer design", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "approve me", cwd: repo });
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1);

    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design v1",
    });

    // human approves via job.tell.
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "approved, go ahead" });

    // supervisor -> implementation now proceeds and dispatches.
    await Bun.sleep(2);
    const beforeImpl = dispatches.length;
    const go = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "implement v1",
    });
    expect(go.ok).toBe(true);
    await waitForDispatches(beforeImpl + 1);
    expect(dispatches.at(-1)!.role).toBe("implementation");

    // a newer design handoff resets the requirement -> gated again.
    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design v2 (revised)",
    });
    await Bun.sleep(2);
    const reblocked = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "implement v2",
    });
    expect(reblocked.ok).toBe(false);
    if (!reblocked.ok) expect(reblocked.error.code).toBe("approval_required");
    c.close();
  });

  it("passes team and role env to the agent, but never over agvsr's own vars", async () => {
    const base = join(tmpdir(), `agvsr-env-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const envTeam = parseTeam(
      `env:\n  DATABASE_TEST_URL: postgres://shared\n  AGVSR_ROLE: hijacked\n` +
        `roles:\n  supervisor: { adapter: claude-code, model: m, env: { DATABASE_TEST_URL: "postgres://sup" } }\n` +
        `  implementation: { adapter: codex, model: m }`,
    );
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: envTeam,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    await c.request("job.create", { goal: "env", cwd: repo });
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    const env = seen[0]!.env;
    // The role's value wins over the team's shared one...
    expect(env.DATABASE_TEST_URL).toBe("postgres://sup");
    // ...but agvsr's own variables are applied last and cannot be shadowed.
    expect(env.AGVSR_ROLE).toBe("supervisor");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("keeps the approval when the human sends an unrelated follow-up message", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "latch me", cwd: repo });
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1);

    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design v1",
      refs: ["docs/design.md"],
    });
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "approved" });

    // Ordinary human messages carrying no verdict must not revoke the approval — this is
    // what used to re-open the gate every time the human passed along env details.
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "DATABASE_TEST_URL=postgres://x/y" });
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "テストDBのポートは 5433 です" });

    await Bun.sleep(2);
    const beforeImpl = dispatches.length;
    const go = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "implement v1",
    });
    expect(go.ok).toBe(true);
    await waitForDispatches(beforeImpl + 1);
    c.close();
  });

  it("accepts a Japanese approval and honours a Japanese rejection", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "ja gate", cwd: repo });
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1);

    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "設計が完了しました",
      refs: ["docs/design.md"],
    });

    await Bun.sleep(2);
    await c.request("job.tell", {
      job_id: jobId,
      body: "承認しますが1点変更があります。A2はZustandで。",
    });
    await Bun.sleep(2);
    const beforeImpl = dispatches.length;
    const go = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "実装してください",
    });
    expect(go.ok).toBe(true);
    await waitForDispatches(beforeImpl + 1);

    // An explicit Japanese rejection revokes it again.
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "やはり承認しません。中止してください。" });
    await Bun.sleep(2);
    const blocked = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "続行してください",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("approval_required");
    c.close();
  });

  it("does not re-gate on a design follow-up about the already approved artifacts", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", { goal: "followup", cwd: repo });
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1);

    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "design handoff",
      refs: ["docs/design.md", "docs/handoff.md"],
    });
    await Bun.sleep(2);
    await c.request("job.tell", { job_id: jobId, body: "approved" });

    // design reports back on the *same* document (e.g. "I committed it to the job branch").
    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "committed the design doc to the job branch",
      refs: ["docs/design.md"],
    });
    await Bun.sleep(2);
    const beforeImpl = dispatches.length;
    const go = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "carry on",
    });
    expect(go.ok).toBe(true);
    await waitForDispatches(beforeImpl + 1);

    // but a handoff that widens the design surface does re-gate.
    await Bun.sleep(2);
    await c.request("msg.send", {
      from: "design",
      job_id: jobId,
      to: "supervisor",
      body: "revised design: new schema",
      refs: ["docs/design.md", "src/schema.ts"],
    });
    await Bun.sleep(2);
    const reblocked = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "implement revision",
    });
    expect(reblocked.ok).toBe(false);
    if (!reblocked.ok) expect(reblocked.error.code).toBe("approval_required");
    c.close();
  });

  it("routes a supervisor escalation to the human, not back to itself", async () => {
    const c = await Client.connect(sock);
    const beforeCreate = dispatches.length;
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "sup escalate",
      cwd: repo,
    });
    const jobId = created.ok ? created.result.job.id : "";
    await waitForDispatches(beforeCreate + 1);

    const res = await c.request<{ queued: true; message: Message }>("msg.escalate", {
      from: "supervisor",
      job_id: jobId,
      reason: "need a human decision on scope",
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.result.message.to_role).toBe("user");
    // it reached the human, so no agent turn was dispatched for it.
    await Bun.sleep(20);
    expect(dispatches.some((d) => d.message.includes("need a human decision on scope"))).toBe(
      false,
    );
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
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", { goal: "tier1", cwd: repo });
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

  it("immediately escalates a worker model/config error from stderrTail without retrying", async () => {
    const base = join(tmpdir(), `agvsr-model-stderr-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const saved = process.env.AGVSR_MAX_WORKER_FAILURES;
    process.env.AGVSR_MAX_WORKER_FAILURES = "1";
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
            events: [{ kind: "result", ok: false, text: "model problem" }],
            outcome: {
              sessionId: "impl-session",
              finalText: "model problem",
              stderrTail: "invalid/unsupported model: gpt-5-codex",
              exitCode: 1,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "stderrTail config error",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      const sent = await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "run the job",
      });
      expect(sent.ok).toBe(true);
      for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
        await Bun.sleep(5);
      }

      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      expect(got.ok && got.result.job.status).toBe("running");
      expect(seen.filter((d) => d.role === "implementation").length).toBe(1);
      expect(seen.filter((d) => d.role === "supervisor").length).toBe(2);

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const escalation = logs.result.messages.find(
        (m) => m.kind === "escalation" && m.from_role === "daemon" && m.to_role === "supervisor",
      );
      expect(escalation).toBeTruthy();
      expect(escalation!.body).toContain("設定エラーの可能性");
      expect(escalation!.body).toContain("implementation.model=gpt-5-codex");
      expect(escalation!.body).toContain("role=implementation");
      expect(escalation!.body).toContain("adapter=codex");
      expect(escalation!.body).toContain("invalid/unsupported model");

      c.close();
    } finally {
      if (saved === undefined) delete process.env.AGVSR_MAX_WORKER_FAILURES;
      else process.env.AGVSR_MAX_WORKER_FAILURES = saved;
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("immediately escalates a worker model/config error from finalText without retrying", async () => {
    const base = join(tmpdir(), `agvsr-model-final-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const saved = process.env.AGVSR_MAX_WORKER_FAILURES;
    process.env.AGVSR_MAX_WORKER_FAILURES = "1";
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
            events: [{ kind: "result", ok: false, text: "unknown model: gpt-5-codex" }],
            outcome: {
              sessionId: "impl-session",
              finalText: "unknown model: gpt-5-codex",
              exitCode: 1,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "finalText config error",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "run the job",
      });
      for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
        await Bun.sleep(5);
      }

      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      expect(got.ok && got.result.job.status).toBe("running");
      expect(seen.filter((d) => d.role === "implementation").length).toBe(1);
      expect(seen.filter((d) => d.role === "supervisor").length).toBe(2);

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const escalation = logs.result.messages.find(
        (m) => m.kind === "escalation" && m.from_role === "daemon" && m.to_role === "supervisor",
      );
      expect(escalation).toBeTruthy();
      expect(escalation!.body).toContain("設定エラーの可能性");
      expect(escalation!.body).toContain("unknown model");

      c.close();
    } finally {
      if (saved === undefined) delete process.env.AGVSR_MAX_WORKER_FAILURES;
      else process.env.AGVSR_MAX_WORKER_FAILURES = saved;
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("parks a worker usage-limit failure for the human without retrying", async () => {
    const base = join(tmpdir(), `agvsr-usage-limit-${randomUUID()}`);
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
          const limit = "You've hit your monthly spend limit";
          return {
            events: [{ kind: "result", ok: false, text: limit }],
            outcome: {
              sessionId: "impl-session",
              finalText: limit,
              exitCode: 1,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "usage limit",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      const sent = await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "run once",
      });
      expect(sent.ok).toBe(true);
      for (let i = 0; i < 100; i++) {
        const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
        if (
          logs.ok &&
          logs.result.messages.some(
            (message) => message.kind === "escalation" && message.to_role === "user",
          )
        ) {
          break;
        }
        await Bun.sleep(5);
      }

      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      expect(got.ok && got.result.job.status).toBe("running");
      expect(seen.filter((dispatch) => dispatch.role === "implementation")).toHaveLength(1);
      expect(seen.filter((dispatch) => dispatch.role === "supervisor")).toHaveLength(1);
      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const escalation = logs.result.messages.find(
        (message) => message.kind === "escalation" && message.to_role === "user",
      );
      expect(escalation?.body).toContain("will not be retried automatically");
      expect(escalation?.body).toContain("monthly spend limit");
      c.close();
    } finally {
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("keeps generic worker failures on the normal failure-count path at threshold 1", async () => {
    const base = join(tmpdir(), `agvsr-generic-fail-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const saved = process.env.AGVSR_MAX_WORKER_FAILURES;
    process.env.AGVSR_MAX_WORKER_FAILURES = "1";
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
            events: [{ kind: "result", ok: false, text: "temporary network failure" }],
            outcome: {
              sessionId: "impl-session",
              finalText: "temporary network failure",
              exitCode: 1,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "generic failure",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "run the job",
      });
      for (let i = 0; i < 100; i++) {
        const got = await c.request<{ job: Job }>("job.get", { id: jobId });
        if (got.ok && got.result.job.status === "failed") break;
        await Bun.sleep(5);
      }

      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      expect(got.ok && got.result.job.status).toBe("failed");
      expect(seen.filter((d) => d.role === "implementation").length).toBe(1);
      expect(seen.filter((d) => d.role === "supervisor").length).toBe(1);

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      expect(
        logs.result.messages.some(
          (m) => m.kind === "failure" && m.to_role === "user" && m.body.includes("threshold 1"),
        ),
      ).toBe(true);

      c.close();
    } finally {
      if (saved === undefined) delete process.env.AGVSR_MAX_WORKER_FAILURES;
      else process.env.AGVSR_MAX_WORKER_FAILURES = saved;
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("interrupts stale running jobs on daemon start", async () => {
    const base = join(tmpdir(), `agvsr-interrupt-test-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const setup = new Store(db);
    const stale = setup.createJob("stale job", repo);
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
            finalText: "",
            exitCode: 0,
          },
        };
      },
    });
    const firstClient = await Client.connect(sock1);
    const created = await firstClient.request<{ job: Job }>("job.create", {
      goal: "persist sessions",
      cwd: repo,
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
          outcome: { sessionId: dispatch.sessionId, finalText: "", exitCode: 0 },
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

  it("normalizes tilde cwd and rejects nonexistent cwd on job.create", async () => {
    const savedHome = process.env.HOME;
    const fakeHome = join(tmpdir(), `agvsr-home-${randomUUID()}`);
    const homeRepo = join(fakeHome, "src", "agvsr");
    mkdirSync(homeRepo, { recursive: true });
    process.env.HOME = fakeHome;

    const c = await Client.connect(sock);
    try {
      const homeRelative = await c.request<{ job: Job }>("job.create", {
        goal: "home cwd",
        cwd: "~/src/agvsr",
      });
      expect(homeRelative.ok).toBe(true);
      if (!homeRelative.ok) throw new Error("job.create failed");
      expect(homeRelative.result.job.cwd).toBe(homeRepo);

      const missing = await c.request("job.create", {
        goal: "bad cwd",
        cwd: "~/definitely-missing-agvsr-cwd",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.message).toContain("cwd does not exist");
    } finally {
      c.close();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("fails a supervisor that keeps ending turns without routing anything", async () => {
    const base = join(tmpdir(), `agvsr-no-tool-test-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => ({
        events: [{ kind: "result", ok: true, text: "tool call was cancelled" }],
        outcome: {
          sessionId: `${dispatch.role}-session`,
          finalText: "I tried agvsr_send, but the tool call was cancelled.",
          exitCode: 0,
        },
      }),
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", { goal: "stalls", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    for (let i = 0; i < 50; i++) {
      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      if (got.ok && got.result.job.status === "failed") break;
      await Bun.sleep(5);
    }

    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("failed");
    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some(
        (m) =>
          m.from_role === "supervisor" &&
          m.to_role === "daemon" &&
          m.body.includes("tool call was cancelled"),
      ),
    ).toBe(true);
    // Nudged first, failed only once the supervisor kept going idle (D36).
    expect(
      logs.result.messages.some(
        (m) =>
          m.kind === "escalation" && m.to_role === "supervisor" && m.body.includes("routed no"),
      ),
    ).toBe(true);
    expect(
      logs.result.messages.some(
        (m) => m.kind === "failure" && m.body.includes("consecutive turns"),
      ),
    ).toBe(true);

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("escalates worker no-route turns to the supervisor and re-dispatches instead of failing the job", async () => {
    const base = join(tmpdir(), `agvsr-worker-noroute-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: supervisor-model }
  implementation: { adapter: codex, model: worker-model }
`),
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        if (dispatch.role === "implementation") {
          return {
            events: [{ kind: "result", ok: true, text: "worker text" }],
            outcome: {
              sessionId: "impl-session",
              finalText: "worker text",
              exitCode: 0,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: "supervisor ack" }],
          outcome: {
            sessionId: `${dispatch.role}-session`,
            finalText: "",
            exitCode: 0,
          },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "worker no-route",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    expect(seen[0]!.role).toBe("supervisor");

    const routed = await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "please continue",
    });
    expect(routed.ok).toBe(true);

    for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
      await Bun.sleep(5);
    }

    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("running");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some(
        (m) =>
          m.kind === "note" &&
          m.from_role === "implementation" &&
          m.to_role === "daemon" &&
          m.body === "worker text",
      ),
    ).toBe(true);
    expect(
      logs.result.messages.some(
        (m) =>
          m.kind === "escalation" &&
          m.from_role === "daemon" &&
          m.to_role === "supervisor" &&
          m.body.includes("Final text:"),
      ),
    ).toBe(true);
    expect(seen.filter((d) => d.role === "supervisor").length).toBeGreaterThanOrEqual(2);

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("rejects an empty goal", async () => {
    const c = await Client.connect(sock);
    const res = await c.request("job.create", { goal: "  ", cwd: repo });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_request");
    c.close();
  });

  it("tells a running job supervisor and dispatches the message", async () => {
    const base = join(tmpdir(), `agvsr-tell-test-${randomUUID()}`);
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
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "tell test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    const beforeTell = seen.length;
    const res = await c.request<{ queued: true; message: Message }>("job.tell", {
      job_id: jobId,
      body: "please prioritize X",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.message.from_role).toBe("user");
      expect(res.result.message.to_role).toBe("supervisor");
      expect(res.result.message.kind).toBe("message");
    }
    for (let i = 0; i < 50 && seen.length < beforeTell + 1; i++) await Bun.sleep(5);
    expect(seen.at(-1)!.role).toBe("supervisor");
    expect(seen.at(-1)!.message).toContain("please prioritize X");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("stops a running job and marks it failed", async () => {
    const base = join(tmpdir(), `agvsr-stop-test-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => ({
        events: [{ kind: "result", ok: true, text: dispatch.role }],
        outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
      }),
    });
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", { goal: "stop me", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    const stopped = await c.request("job.stop", { job_id: jobId });
    expect(stopped.ok).toBe(true);

    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("failed");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.body === "Job stopped by user.")).toBe(true);

    const alreadyStopped = await c.request("job.stop", { job_id: jobId });
    expect(alreadyStopped.ok).toBe(false);
    if (!alreadyStopped.ok) expect(alreadyStopped.error.code).toBe("bad_request");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("notifies once when a running job becomes stalled, then re-arms after new activity", async () => {
    const base = join(tmpdir(), `agvsr-stall-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const fired: Array<{ event: string; job_id: string; idle_ms?: number }> = [];
    const seen: TurnDispatch[] = [];
    const oldStallTimeout = process.env.AGVSR_STALL_TIMEOUT_MS;
    process.env.AGVSR_STALL_TIMEOUT_MS = "50";
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: supervisor-model }
hooks:
  on_job_stalled: echo stalled
`),
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: "" }],
          outcome: {
            sessionId: `${dispatch.role}-session`,
            finalText: "",
            exitCode: 0,
          },
        };
      },
      hookRunner: (_cmd, event) => {
        fired.push(event as { event: string; job_id: string; idle_ms?: number });
      },
    });
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "stall me",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    for (let i = 0; i < 100 && seen.length < 1; i++) await Bun.sleep(5);
    for (let i = 0; i < 100; i++) {
      const rt = await c.request<{
        job: Job;
        runtime: { in_flight: boolean; idle_ms: number | null };
      }>("job.get", { id: jobId });
      if (rt.ok && !rt.result.runtime.in_flight) break;
      await Bun.sleep(5);
    }

    const before = await c.request<{
      job: Job;
      runtime: { in_flight: boolean; idle_ms: number | null };
    }>("job.get", { id: jobId });
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error("job.get failed");
    const beforeMessages = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(beforeMessages.ok).toBe(true);
    if (!beforeMessages.ok) throw new Error("msg.list failed");

    for (let i = 0; i < 100 && fired.length < 1; i++) await Bun.sleep(5);
    expect(fired.length).toBe(1);
    expect(fired[0]!.event).toBe("job_stalled");
    expect(fired[0]!.job_id).toBe(jobId);
    expect(fired[0]!.idle_ms).toBeGreaterThanOrEqual(50);

    const after = await c.request<{
      job: Job;
      runtime: { in_flight: boolean; idle_ms: number | null };
    }>("job.get", { id: jobId });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("job.get failed");
    expect(after.result.runtime.idle_ms!).toBeGreaterThanOrEqual(before.result.runtime.idle_ms!);
    const afterMessages = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(afterMessages.ok).toBe(true);
    if (!afterMessages.ok) throw new Error("msg.list failed");
    expect(afterMessages.result.messages.length).toBe(beforeMessages.result.messages.length);

    await Bun.sleep(120);
    expect(fired.length).toBe(1);

    const retell = await c.request("job.tell", { job_id: jobId, body: "resume work" });
    expect(retell.ok).toBe(true);
    for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
      await Bun.sleep(5);
    }

    for (let i = 0; i < 100 && fired.length < 2; i++) await Bun.sleep(5);
    expect(fired.length).toBe(2);
    expect(fired[1]!.job_id).toBe(jobId);

    const afterRetellMessages = await c.request<{ messages: Message[] }>("msg.list", {
      job_id: jobId,
    });
    expect(afterRetellMessages.ok).toBe(true);
    if (!afterRetellMessages.ok) throw new Error("msg.list failed");
    expect(afterRetellMessages.result.messages.length).toBe(2);
    expect(afterRetellMessages.result.messages.every((m) => m.kind === "message")).toBe(true);

    if (oldStallTimeout === undefined) delete process.env.AGVSR_STALL_TIMEOUT_MS;
    else process.env.AGVSR_STALL_TIMEOUT_MS = oldStallTimeout;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("hard-fails a job when a worker exceeds the consecutive failure threshold (Tier2)", async () => {
    const base = join(tmpdir(), `agvsr-tier2-test-${randomUUID()}`);
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
            events: [{ kind: "result", ok: false, text: "always fails" }],
            outcome: { sessionId: "impl-session", finalText: "always fails", exitCode: 1 },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });
    process.env.AGVSR_MAX_WORKER_FAILURES = "2";
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "tier2 test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "fail once",
    });
    for (let i = 0; i < 50 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
      await Bun.sleep(5);
    }

    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "implementation",
      body: "fail twice",
    });
    for (let i = 0; i < 100; i++) {
      const r = await c.request<{ job: Job }>("job.get", { id: jobId });
      if (!r.ok || r.result.job.status !== "running") break;
      await Bun.sleep(5);
    }

    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("failed");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some(
        (m) => m.kind === "failure" && m.to_role === "user" && m.body.includes("Tier2"),
      ),
    ).toBe(true);

    delete process.env.AGVSR_MAX_WORKER_FAILURES;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("sends Tier1 escalation to supervisor after N no-tool-use turns by a worker", async () => {
    const base = join(tmpdir(), `agvsr-noprogress-${randomUUID()}`);
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
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
    process.env.AGVSR_NO_PROGRESS_TURNS = "2";
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "no-progress",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    // Two turns from implementation with no tool_use events → Tier1 on second turn
    for (let turn = 0; turn < 2; turn++) {
      const beforeSend = seen.filter((d) => d.role === "supervisor").length;
      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: `work turn ${turn}`,
      });
      if (turn === 1) {
        for (
          let i = 0;
          i < 100 && seen.filter((d) => d.role === "supervisor").length < beforeSend + 1;
          i++
        ) {
          await Bun.sleep(5);
        }
      } else {
        for (
          let i = 0;
          i < 50 && seen.filter((d) => d.role === "implementation").length < turn + 1;
          i++
        ) {
          await Bun.sleep(5);
        }
      }
    }

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some((m) => m.kind === "escalation" && m.body.includes("no-progress")),
    ).toBe(true);
    expect(seen.at(-1)!.role).toBe("supervisor");

    delete process.env.AGVSR_NO_PROGRESS_TURNS;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("sends Tier1 escalation when a worker repeats identical tool calls", async () => {
    const base = join(tmpdir(), `agvsr-loopfp-${randomUUID()}`);
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
        const events =
          dispatch.role === "implementation"
            ? [
                { kind: "tool_use" as const, name: "bash", input: { command: "ls" } },
                { kind: "result" as const, ok: true },
              ]
            : [{ kind: "result" as const, ok: true, text: dispatch.role }];
        return {
          events,
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
    process.env.AGVSR_LOOP_REPEAT_TURNS = "2";
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", { goal: "loop fp", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    for (let turn = 0; turn < 2; turn++) {
      const beforeSupervisor = seen.filter((d) => d.role === "supervisor").length;
      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: `repeat ${turn}`,
      });
      if (turn === 1) {
        for (
          let i = 0;
          i < 100 && seen.filter((d) => d.role === "supervisor").length < beforeSupervisor + 1;
          i++
        ) {
          await Bun.sleep(5);
        }
      } else {
        for (
          let i = 0;
          i < 50 && seen.filter((d) => d.role === "implementation").length < turn + 1;
          i++
        ) {
          await Bun.sleep(5);
        }
      }
    }

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(
      logs.result.messages.some((m) => m.kind === "escalation" && m.body.includes("loop Tier1")),
    ).toBe(true);

    delete process.env.AGVSR_LOOP_REPEAT_TURNS;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("Tier2 hard-fails a job after N loop escalations", async () => {
    const base = join(tmpdir(), `agvsr-looptier2-${randomUUID()}`);
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
        const events =
          dispatch.role === "implementation"
            ? [{ kind: "result" as const, ok: true, text: "text only" }]
            : [{ kind: "result" as const, ok: true, text: dispatch.role }];
        return {
          events,
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
    process.env.AGVSR_NO_PROGRESS_TURNS = "1";
    process.env.AGVSR_MAX_LOOP_ESCALATIONS = "2";
    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "loop tier2",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    for (let turn = 0; turn < 2; turn++) {
      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: `no progress ${turn}`,
      });
      for (let i = 0; i < 100; i++) {
        const r = await c.request<{ job: Job }>("job.get", { id: jobId });
        if (!r.ok) break;
        const status = r.result.job.status;
        if (status === "failed") break;
        if (turn === 0 && seen.filter((d) => d.role === "supervisor").length >= 2) break;
        await Bun.sleep(5);
      }
    }

    for (let i = 0; i < 100; i++) {
      const r = await c.request<{ job: Job }>("job.get", { id: jobId });
      if (!r.ok || r.result.job.status !== "running") break;
      await Bun.sleep(5);
    }
    const got = await c.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok && got.result.job.status).toBe("failed");
    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.kind === "failure" && m.body.includes("Tier2"))).toBe(
      true,
    );

    delete process.env.AGVSR_NO_PROGRESS_TURNS;
    delete process.env.AGVSR_MAX_LOOP_ESCALATIONS;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("msg.watch pushes new messages to the subscriber in real time", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    // Create a job via c1
    const created = await c1.request<{ job: Job }>("job.create", {
      goal: "push test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    // Subscribe c2 to push frames for that job
    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    const watchRes = await c2.request("msg.watch", { job_id: jobId });
    expect(watchRes.ok).toBe(true);

    // Send a message via c1 → should push to c2
    const sent = await c1.request<{ message: Message }>("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "design",
      body: "pushed hello",
    });
    expect(sent.ok).toBe(true);

    // Wait for push frame
    for (let i = 0; i < 50 && pushed.length === 0; i++) await Bun.sleep(5);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]!.event).toBe("msg.new");
    const p0 = pushed[0]!;
    if (p0.event !== "msg.new") throw new Error("expected msg.new frame");
    expect(p0.data.body).toBe("pushed hello");
    expect(p0.data.job_id).toBe(jobId);

    c1.close();
    c2.close();
  });

  it("msg.watch does not push frames for a different job", async () => {
    const c = await Client.connect(sock);

    const j1 = await c.request<{ job: Job }>("job.create", { goal: "job one", cwd: repo });
    const j2 = await c.request<{ job: Job }>("job.create", { goal: "job two", cwd: repo });
    expect(j1.ok && j2.ok).toBe(true);
    if (!j1.ok || !j2.ok) throw new Error();

    // Watch job1 only
    const pushed: PushFrame[] = [];
    c.onPush = (f) => pushed.push(f);
    await c.request("msg.watch", { job_id: j1.result.job.id });

    // Send message on job2
    await c.request("msg.send", {
      from: "supervisor",
      job_id: j2.result.job.id,
      to: "design",
      body: "should not arrive",
    });
    await Bun.sleep(30);
    expect(pushed.length).toBe(0);

    c.close();
  });

  it("msg.watch returns not_found for unknown job", async () => {
    const c = await Client.connect(sock);
    const res = await c.request("msg.watch", { job_id: randomUUID() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
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

  it("starts, lazy-loads, and reloads with suspicious models without blocking", async () => {
    const base = join(tmpdir(), `agvsr-model-warn-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const yamlPath = `${base}.team.yaml`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    try {
      const { startDaemon } = await import("../src/daemon/daemon.ts");
      const started = await startDaemon({
        endpoint: sockLocal,
        storeFile: db,
        team: parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
`),
        interruptRunningJobsOnStart: false,
        turnRunner: async () => ({
          events: [{ kind: "result", ok: true, text: "ok" }],
          outcome: { sessionId: "warn-session", finalText: "", exitCode: 0 },
        }),
      });

      const c = await Client.connect(sockLocal);
      const team = await c.request<{ roles: RoleSummary[] }>("team.get");
      expect(team.ok).toBe(true);

      const created = await c.request<{ job: Job }>("job.create", { goal: "warn me", cwd: repo });
      expect(created.ok).toBe(true);

      await started.close();
      c.close();

      const lazyDaemon = await startDaemon({
        endpoint: `${sockLocal}-lazy`,
        storeFile: `${db}-lazy`,
        teamFile: yamlPath,
        interruptRunningJobsOnStart: false,
        turnRunner: async () => ({
          events: [{ kind: "result", ok: true, text: "ok" }],
          outcome: { sessionId: "lazy-session", finalText: "", exitCode: 0 },
        }),
      });

      writeFileSync(
        yamlPath,
        `
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
`,
      );

      const lazyClient = await Client.connect(`${sockLocal}-lazy`);
      const lazyCreated = await lazyClient.request<{ job: Job }>("job.create", {
        goal: "lazy warn",
        cwd: repoLocal,
      });
      expect(lazyCreated.ok).toBe(true);

      writeFileSync(
        yamlPath,
        `
roles:
  supervisor: { adapter: claude-code, model: sonnet-4.6 }
`,
      );
      const reloaded = await lazyClient.request<{ roles: RoleSummary[] }>("reload");
      expect(reloaded.ok).toBe(true);
      lazyClient.close();
      await lazyDaemon.close();
    } finally {
      for (const f of [
        sockLocal,
        db,
        `${db}-wal`,
        `${db}-shm`,
        `${sockLocal}-lazy`,
        `${db}-lazy`,
        `${db}-lazy-wal`,
        `${db}-lazy-shm`,
        yamlPath,
        repoLocal,
      ]) {
        try {
          rmSync(f, { recursive: true });
        } catch {}
      }
    }
  });

  it("emits debug warnings when AGVSR_DEBUG is enabled", async () => {
    const base = join(tmpdir(), `agvsr-model-debug-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const lazySock = `${sockLocal}-lazy`;
    const lazyDb = `${db}-lazy`;
    const yamlPath = `${base}.team.yaml`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    const daemonPath = JSON.stringify(join(import.meta.dir, "../src/daemon/daemon.ts"));
    const clientPath = JSON.stringify(join(import.meta.dir, "../src/ipc/transport.ts"));
    const teamPath = JSON.stringify(join(import.meta.dir, "../src/config/team.ts"));
    const script = `
process.env.AGVSR_DEBUG = "1";
const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { Client } = await import(${clientPath});
const { parseTeam } = await import(${teamPath});
const { startDaemon } = await import(${daemonPath});

const base = join(tmpdir(), "agvsr-model-debug-" + randomUUID());
const sockLocal = ${JSON.stringify(sockLocal)};
const db = ${JSON.stringify(db)};
const lazySock = ${JSON.stringify(lazySock)};
const lazyDb = ${JSON.stringify(lazyDb)};
const yamlPath = ${JSON.stringify(yamlPath)};
const repoLocal = ${JSON.stringify(repoLocal)};
mkdirSync(repoLocal, { recursive: true });

const noopTurn = async () => ({
  events: [{ kind: "result", ok: true, text: "ok" }],
  outcome: { sessionId: "session", finalText: "", exitCode: 0 },
});

const daemon = await startDaemon({
  endpoint: sockLocal,
  storeFile: db,
  team: parseTeam(\`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
\`),
  interruptRunningJobsOnStart: false,
  turnRunner: noopTurn,
});
const client = await Client.connect(sockLocal);
const team = await client.request("team.get");
if (!team.ok) throw new Error("team.get failed");
await daemon.close();
client.close();

const lazyDaemon = await startDaemon({
  endpoint: lazySock,
  storeFile: lazyDb,
  teamFile: yamlPath,
  interruptRunningJobsOnStart: false,
  turnRunner: noopTurn,
});
writeFileSync(yamlPath, \`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
\`);
const lazyClient = await Client.connect(lazySock);
const created = await lazyClient.request("job.create", { goal: "lazy warn", cwd: repoLocal });
if (!created.ok) throw new Error("job.create failed");
writeFileSync(yamlPath, \`
roles:
  supervisor: { adapter: claude-code, model: sonnet-4.6 }
\`);
const reloaded = await lazyClient.request("reload");
if (!reloaded.ok) throw new Error("reload failed");
lazyClient.close();
await lazyDaemon.close();
rmSync(repoLocal, { recursive: true, force: true });
rmSync(yamlPath, { force: true });
`;

    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toContain("team startup model warning");
    expect(stderr).toContain("team lazy-load model warning");
    expect(stderr).toContain("team reload model warning");
  });

  it("reloads team.yaml at runtime and reflects new roles (D17)", async () => {
    const base = join(tmpdir(), `agvsr-reload-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const yamlPath = `${base}.team.yaml`;
    const seen: TurnDispatch[] = [];

    writeFileSync(
      yamlPath,
      `roles:\n  supervisor: { adapter: claude-code, model: claude-opus-4-8 }\n  design: { adapter: claude-code, model: claude-sonnet-4-6 }\n`,
    );
    process.env.AGVSR_TEAM = yamlPath;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    const before = await c.request<{ roles: RoleSummary[] }>("team.get");
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.result.roles.map((r) => r.name)).toContain("design");

    // Update team.yaml on disk — swap design for a new "qa" role
    writeFileSync(
      yamlPath,
      `roles:\n  supervisor: { adapter: claude-code, model: claude-opus-4-8 }\n  qa: { adapter: agy, model: gemini-3-pro }\n`,
    );
    const reloaded = await c.request<{ roles: RoleSummary[] }>("reload");
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      const names = reloaded.result.roles.map((r) => r.name);
      expect(names).toContain("qa");
      expect(names).not.toContain("design");
    }

    // team.get now reflects new config
    const after = await c.request<{ roles: RoleSummary[] }>("team.get");
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.result.roles.map((r) => r.name)).toContain("qa");

    delete process.env.AGVSR_TEAM;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, yamlPath]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("reload returns an error when team.yaml is missing or invalid", async () => {
    const base = join(tmpdir(), `agvsr-reload-err-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const yamlPath = `${base}-nonexistent.yaml`;
    process.env.AGVSR_TEAM = yamlPath;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(`roles:\n  supervisor: { adapter: claude-code, model: m }\n`),
      interruptRunningJobsOnStart: false,
      turnRunner: async (d) => ({
        events: [],
        outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
      }),
    });

    const c = await Client.connect(sockLocal);
    const res = await c.request("reload");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("reload_failed");

    // Original team is still operational
    const ping = await c.request<{ roles: RoleSummary[] }>("team.get");
    expect(ping.ok).toBe(true);

    delete process.env.AGVSR_TEAM;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("running jobs keep their team snapshot after reload (D17)", async () => {
    const base = join(tmpdir(), `agvsr-reload-snap-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const yamlPath = `${base}.team.yaml`;
    const seen: TurnDispatch[] = [];

    const oldYaml = `roles:\n  supervisor: { adapter: claude-code, model: old-model }\n  impl: { adapter: codex, model: old-model }\n`;
    writeFileSync(yamlPath, oldYaml);
    process.env.AGVSR_TEAM = yamlPath;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
    const c = await Client.connect(sockLocal);

    // Create job BEFORE reload — snapshot should be old team
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "snap test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    // Reload with a team that has only supervisor (no impl)
    writeFileSync(yamlPath, `roles:\n  supervisor: { adapter: claude-code, model: new-model }\n`);
    const reloadRes = await c.request("reload");
    expect(reloadRes.ok).toBe(true);

    // Routing for the OLD job must still accept impl (snapshot has it)
    const sent = await c.request<{ queued: true; message: Message }>("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "impl",
      body: "continue",
    });
    expect(sent.ok).toBe(true); // routing must work via snapshot

    // The audit log must contain the impl message
    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.to_role === "impl" && m.body === "continue")).toBe(
      true,
    );

    // New job after reload — routing to impl must be FORBIDDEN (not in new team)
    const newCreated = await c.request<{ job: Job }>("job.create", {
      goal: "new after reload",
      cwd: repo,
    });
    expect(newCreated.ok).toBe(true);
    const newJobId = newCreated.ok ? newCreated.result.job.id : "";
    for (let i = 0; i < 50 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
      await Bun.sleep(5);
    }
    const forbidden = await c.request("msg.send", {
      from: "supervisor",
      job_id: newJobId,
      to: "impl",
      body: "should fail",
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("forbidden");

    delete process.env.AGVSR_TEAM;
    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, yamlPath]) {
      try {
        rmSync(f);
      } catch {}
    }
  });

  it("lazy-loads team.yaml on job.create and reports a helpful error when missing", async () => {
    const base = join(tmpdir(), `agvsr-lazy-team-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const yamlPath = `${base}.team.yaml`;
    const seen: TurnDispatch[] = [];

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    // Start daemon without team and without an existing yaml file.
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      teamFile: yamlPath,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        seen.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);

    // No team.yaml yet — error should mention the path and supervisor requirement.
    const missing = await c.request("job.create", { goal: "lazy test", cwd: repo });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("no_team");
      expect(missing.error.message).toContain(yamlPath);
      expect(missing.error.message).toContain("supervisor");
    }

    // Write a minimal team.yaml (supervisor only) — no restart needed.
    writeFileSync(
      yamlPath,
      `roles:\n  supervisor: { adapter: claude-code, model: claude-opus-4-8 }\n`,
    );

    // Next job.create should lazy-load and succeed.
    const created = await c.request<{ job: Job }>("job.create", { goal: "lazy test 2", cwd: repo });
    expect(created.ok).toBe(true);
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    expect(seen[0]!.role).toBe("supervisor");
    // supervisor-only team: allowed targets should only include "user".
    expect(seen[0]!.env.AGVSR_ALLOWED).toBe("user");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, yamlPath]) {
      try {
        rmSync(f);
      } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// AC-5: Timeout resolution (role config > env > default) and AC-4/AC-6 tests
// ---------------------------------------------------------------------------

describe("turn timeout resolution (AC-5, AC-6)", () => {
  const mkBase = () => join(tmpdir(), `agvsr-timeout-res-${randomUUID()}`);

  async function captureDispatch(
    teamYaml: string,
    env: Record<string, string>,
  ): Promise<import("../src/daemon/daemon.ts").TurnDispatch> {
    const base = mkBase();
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    const saved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k] ?? "";
      process.env[k] = v;
    }

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    let captured: import("../src/daemon/daemon.ts").TurnDispatch | null = null;
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(teamYaml),
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        captured = dispatch;
        return {
          events: [{ kind: "result", ok: true, text: "ok" }],
          outcome: { sessionId: null, finalText: "", exitCode: 0 },
        };
      },
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "timeout test",
      cwd: repoLocal,
    });
    expect(created.ok).toBe(true);

    for (let i = 0; i < 100 && !captured; i++) await Bun.sleep(5);

    c.close();
    await localDaemon.close();

    for (const [k, v] of Object.entries(saved)) {
      if (v === "") delete process.env[k];
      else process.env[k] = v;
    }
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
      try {
        rmSync(f, { recursive: true });
      } catch {}
    }

    if (!captured) throw new Error("no dispatch received");
    return captured;
  }

  it("uses defaults when role has no timeout config and no env vars", async () => {
    const saved = {
      AGVSR_TURN_HARD_TIMEOUT_MS: process.env.AGVSR_TURN_HARD_TIMEOUT_MS,
      AGVSR_TURN_IDLE_TIMEOUT_MS: process.env.AGVSR_TURN_IDLE_TIMEOUT_MS,
      AGVSR_TURN_TIMEOUT_MS: process.env.AGVSR_TURN_TIMEOUT_MS,
    };
    delete process.env.AGVSR_TURN_HARD_TIMEOUT_MS;
    delete process.env.AGVSR_TURN_IDLE_TIMEOUT_MS;
    delete process.env.AGVSR_TURN_TIMEOUT_MS;
    try {
      const d = await captureDispatch(
        `roles:\n  supervisor: { adapter: claude-code, model: m }`,
        {},
      );
      expect(d.hardTimeoutMs).toBe(60 * 60 * 1000);
      expect(d.idleTimeoutMs).toBe(10 * 60 * 1000);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("env AGVSR_TURN_HARD_TIMEOUT_MS overrides default hard", async () => {
    const d = await captureDispatch(`roles:\n  supervisor: { adapter: claude-code, model: m }`, {
      AGVSR_TURN_HARD_TIMEOUT_MS: "30000",
      AGVSR_TURN_IDLE_TIMEOUT_MS: "",
    });
    expect(d.hardTimeoutMs).toBe(30000);
  });

  it("env AGVSR_TURN_IDLE_TIMEOUT_MS overrides default idle", async () => {
    const d = await captureDispatch(`roles:\n  supervisor: { adapter: claude-code, model: m }`, {
      AGVSR_TURN_IDLE_TIMEOUT_MS: "20000",
      AGVSR_TURN_HARD_TIMEOUT_MS: "",
    });
    expect(d.idleTimeoutMs).toBe(20000);
  });

  it("role hard_timeout_ms wins over env", async () => {
    const d = await captureDispatch(
      `roles:\n  supervisor: { adapter: claude-code, model: m, hard_timeout_ms: 7200000 }`,
      { AGVSR_TURN_HARD_TIMEOUT_MS: "3600000" },
    );
    expect(d.hardTimeoutMs).toBe(7200000);
  });

  it("role idle_timeout_ms wins over env", async () => {
    const d = await captureDispatch(
      `roles:\n  supervisor: { adapter: claude-code, model: m, idle_timeout_ms: 1200000 }`,
      { AGVSR_TURN_IDLE_TIMEOUT_MS: "300000" },
    );
    expect(d.idleTimeoutMs).toBe(1200000);
  });

  it("idle is clamped to hard when idle > hard", async () => {
    const d = await captureDispatch(
      `roles:\n  supervisor: { adapter: claude-code, model: m, idle_timeout_ms: 3600000, hard_timeout_ms: 1200000 }`,
      {},
    );
    expect(d.idleTimeoutMs).toBe(d.hardTimeoutMs);
    expect(d.hardTimeoutMs).toBe(1200000);
  });

  it("AC-6: AGVSR_TURN_TIMEOUT_MS feeds hard fallback when new hard env absent", async () => {
    const saved = process.env.AGVSR_TURN_HARD_TIMEOUT_MS;
    delete process.env.AGVSR_TURN_HARD_TIMEOUT_MS;
    try {
      const d = await captureDispatch(`roles:\n  supervisor: { adapter: claude-code, model: m }`, {
        AGVSR_TURN_TIMEOUT_MS: "45000",
      });
      expect(d.hardTimeoutMs).toBe(45000);
    } finally {
      if (saved === undefined) delete process.env.AGVSR_TURN_HARD_TIMEOUT_MS;
      else process.env.AGVSR_TURN_HARD_TIMEOUT_MS = saved;
      delete process.env.AGVSR_TURN_TIMEOUT_MS;
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: daemon fails job with correct timeout kind in failure reason
// ---------------------------------------------------------------------------

describe("timeout failure reasons (AC-4)", () => {
  it("reports idle timeout kind in failure message", async () => {
    const base = join(tmpdir(), `agvsr-idle-fail-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(`roles:\n  supervisor: { adapter: claude-code, model: m }`),
      interruptRunningJobsOnStart: false,
      turnRunner: async () => ({
        events: [],
        outcome: {
          sessionId: null,
          finalText: "",
          exitCode: 1,
          timedOut: true,
          timeoutKind: "idle" as const,
        },
      }),
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "idle fail",
      cwd: repoLocal,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    for (let i = 0; i < 100; i++) {
      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      if (got.ok && got.result.job.status === "failed") break;
      await Bun.sleep(5);
    }

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    const failMsg = logs.result.messages.find((m) => m.kind === "failure");
    expect(failMsg).toBeTruthy();
    expect(failMsg!.body).toContain("no-progress timeout");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
      try {
        rmSync(f, { recursive: true });
      } catch {}
    }
  });

  it("reports hard timeout kind in failure message", async () => {
    const base = join(tmpdir(), `agvsr-hard-fail-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: parseTeam(`roles:\n  supervisor: { adapter: claude-code, model: m }`),
      interruptRunningJobsOnStart: false,
      turnRunner: async () => ({
        events: [],
        outcome: {
          sessionId: null,
          finalText: "",
          exitCode: 1,
          timedOut: true,
          timeoutKind: "hard" as const,
        },
      }),
    });

    const c = await Client.connect(sockLocal);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "hard fail",
      cwd: repoLocal,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    for (let i = 0; i < 100; i++) {
      const got = await c.request<{ job: Job }>("job.get", { id: jobId });
      if (got.ok && got.result.job.status === "failed") break;
      await Bun.sleep(5);
    }

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    const failMsg = logs.result.messages.find((m) => m.kind === "failure");
    expect(failMsg).toBeTruthy();
    expect(failMsg!.body).toContain("hard timeout");

    c.close();
    await localDaemon.close();
    for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
      try {
        rmSync(f, { recursive: true });
      } catch {}
    }
  });

  it("retry escalation body includes exitCode, adapter, model, and stderrTail", async () => {
    const base = join(tmpdir(), `agvsr-diag-retry-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const STDERR_MARKER = "STDERR_DIAG_MARKER_RETRY_TEST";
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
            outcome: {
              sessionId: "impl-session",
              finalText: "boom",
              exitCode: 2,
              stderrTail: STDERR_MARKER,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "diag-retry",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "please fail",
      });
      for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
        await Bun.sleep(5);
      }

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const esc = logs.result.messages.find(
        (m) => m.kind === "escalation" && m.from_role === "daemon" && m.to_role === "supervisor",
      );
      expect(esc).toBeTruthy();
      expect(esc!.body).toContain("exitCode=2");
      expect(esc!.body).toContain("adapter=codex");
      expect(esc!.body).toContain("model=gpt-5-codex");
      expect(esc!.body).toContain(STDERR_MARKER);

      c.close();
    } finally {
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("hard-fail user-facing body includes exitCode/adapter/model but not raw stderr", async () => {
    const base = join(tmpdir(), `agvsr-diag-hardfail-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const STDERR_MARKER = "STDERR_DIAG_MARKER_HARDFAIL_TEST";
    const saved = process.env.AGVSR_MAX_WORKER_FAILURES;
    process.env.AGVSR_MAX_WORKER_FAILURES = "1";
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
            outcome: {
              sessionId: "impl-session",
              finalText: "boom",
              exitCode: 3,
              stderrTail: STDERR_MARKER,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "diag-hardfail",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "please fail",
      });
      for (let i = 0; i < 100; i++) {
        const got = await c.request<{ job: Job }>("job.get", { id: jobId });
        if (got.ok && got.result.job.status === "failed") break;
        await Bun.sleep(5);
      }

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const failMsg = logs.result.messages.find(
        (m) => m.kind === "failure" && m.to_role === "user" && m.from_role === "daemon",
      );
      expect(failMsg).toBeTruthy();
      expect(failMsg!.body).toContain("exitCode=3");
      expect(failMsg!.body).toContain("adapter=codex");
      expect(failMsg!.body).toContain("model=gpt-5-codex");
      expect(failMsg!.body).not.toContain(STDERR_MARKER);

      c.close();
    } finally {
      if (saved === undefined) delete process.env.AGVSR_MAX_WORKER_FAILURES;
      else process.env.AGVSR_MAX_WORKER_FAILURES = saved;
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });

  it("supervisor non-timeout failure body includes exitCode, adapter, and model", async () => {
    const base = join(tmpdir(), `agvsr-diag-sup-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async () => ({
        events: [],
        outcome: { sessionId: null, finalText: "", exitCode: 5 },
      }),
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "sup-non-timeout-fail",
        cwd: repoLocal,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";

      for (let i = 0; i < 100; i++) {
        const got = await c.request<{ job: Job }>("job.get", { id: jobId });
        if (got.ok && got.result.job.status === "failed") break;
        await Bun.sleep(5);
      }

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const failMsg = logs.result.messages.find((m) => m.kind === "failure");
      expect(failMsg).toBeTruthy();
      expect(failMsg!.body).toContain("exitCode=5");
      expect(failMsg!.body).toContain("adapter=claude-code");
      expect(failMsg!.body).toContain("model=claude-opus-4-8");

      c.close();
    } finally {
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
        try {
          rmSync(f, { recursive: true });
        } catch {}
      }
    }
  });

  it("timeout failure body is unchanged and does not contain exitCode= or stderrTail", async () => {
    const base = join(tmpdir(), `agvsr-diag-timeout-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const repoLocal = `${base}-repo`;
    mkdirSync(repoLocal, { recursive: true });
    const STDERR_MARKER = "STDERR_DIAG_MARKER_TIMEOUT_TEST";
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const localDaemon = await startDaemon({
      endpoint: sockLocal,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async () => ({
        events: [],
        outcome: {
          sessionId: null,
          finalText: "",
          exitCode: 1,
          timedOut: true,
          timeoutKind: "idle" as const,
          stderrTail: STDERR_MARKER,
        },
      }),
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "timeout-unchanged",
        cwd: repoLocal,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";

      for (let i = 0; i < 100; i++) {
        const got = await c.request<{ job: Job }>("job.get", { id: jobId });
        if (got.ok && got.result.job.status === "failed") break;
        await Bun.sleep(5);
      }

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const failMsg = logs.result.messages.find((m) => m.kind === "failure");
      expect(failMsg).toBeTruthy();
      expect(failMsg!.body).toContain("no-progress timeout");
      expect(failMsg!.body).not.toContain("exitCode=");
      expect(failMsg!.body).not.toContain(STDERR_MARKER);

      c.close();
    } finally {
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`, repoLocal]) {
        try {
          rmSync(f, { recursive: true });
        } catch {}
      }
    }
  });

  it("long stderrTail in retry escalation is truncated keeping tail, dropping head", async () => {
    const base = join(tmpdir(), `agvsr-diag-bound-${randomUUID()}`);
    const sockLocal = `${base}.sock`;
    const db = `${base}.sqlite`;
    const seen: TurnDispatch[] = [];
    const HEAD_MARKER = "STDERR_DIAG_HEAD_MARKER";
    const TAIL_MARKER = "STDERR_DIAG_TAIL_MARKER";
    const longStderr = HEAD_MARKER + "x".repeat(3000) + TAIL_MARKER;
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
            events: [{ kind: "result", ok: false, text: "err" }],
            outcome: {
              sessionId: "impl-session",
              finalText: "err",
              exitCode: 1,
              stderrTail: longStderr,
            },
          };
        }
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
        };
      },
    });

    try {
      const c = await Client.connect(sockLocal);
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "diag-bound",
        cwd: repo,
      });
      expect(created.ok).toBe(true);
      const jobId = created.ok ? created.result.job.id : "";
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

      await c.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "please fail",
      });
      for (let i = 0; i < 100 && seen.filter((d) => d.role === "supervisor").length < 2; i++) {
        await Bun.sleep(5);
      }

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
      expect(logs.ok).toBe(true);
      if (!logs.ok) throw new Error("msg.list failed");
      const esc = logs.result.messages.find(
        (m) => m.kind === "escalation" && m.from_role === "daemon" && m.to_role === "supervisor",
      );
      expect(esc).toBeTruthy();
      expect(esc!.body).toContain(TAIL_MARKER);
      expect(esc!.body).not.toContain(HEAD_MARKER);

      c.close();
    } finally {
      await localDaemon.close();
      for (const f of [sockLocal, db, `${db}-wal`, `${db}-shm`]) {
        try {
          rmSync(f);
        } catch {}
      }
    }
  });
});
