/**
 * The delegation guard (D44).
 *
 * A supervisor delegated a design and 30 seconds later told the human that
 * design was unresponsive — while design had not yet run a single turn. These
 * tests pin the two actions that wasted the human round-trip.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam, type TeamConfig } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  design: { adapter: claude-code, model: m }
  qa: { adapter: agy, model: m }
`);

const trash: string[] = [];
let openDaemon: Daemon | null = null;
/** Releases any worker turn this test is holding — the daemon cannot drain otherwise. */
let releaseHeldTurns: (() => void) | null = null;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  releaseHeldTurns?.();
  releaseHeldTurns = null;
  if (openDaemon) {
    await openDaemon.close();
    openDaemon = null;
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const p of trash.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * A daemon whose worker turns block until released, so a delegate can be held
 * in the "dispatched but never finished a turn" state the guard is about.
 * The cwd is not a git repo, keeping this file about the guard alone.
 */
async function setup(team: TeamConfig = TEAM) {
  const base = join(tmpdir(), `agvsr-delegation-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  const held: Array<() => void> = [];
  const dispatches: TurnDispatch[] = [];
  /** Roles whose turn has actually returned — what the guard keys off. */
  const completed: string[] = [];
  let blockWorkers = true;

  const releaseWorkers = () => {
    blockWorkers = false;
    for (const release of held.splice(0)) release();
  };
  releaseHeldTurns = releaseWorkers;

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const sock = join(base, "d.sock");
  openDaemon = await startDaemon({
    endpoint: sock,
    storeFile: join(base, "d.sqlite"),
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d) => {
      dispatches.push(d);
      if (blockWorkers && d.role !== "supervisor") {
        await new Promise<void>((resolve) => held.push(resolve));
      }
      completed.push(d.role);
      return {
        events: [{ kind: "result", ok: true, text: d.role }],
        outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
      };
    },
  });

  const c = await Client.connect(sock);
  const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
  if (!created.ok) throw new Error("job.create failed");
  return { c, job: created.result.job, dispatches, completed, releaseWorkers };
}

async function waitFor(check: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
}

describe("re-sending to a delegate that has not started (D44)", () => {
  it("refuses a second message however it is worded", async () => {
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    // A reworded nudge — exactly what walked past the body-equality check.
    const nudge = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "進捗確認です",
    });

    expect(nudge.ok).toBe(false);
    if (!nudge.ok) {
      expect(nudge.error.code).toBe("delegate_not_started");
      expect(nudge.error.message).toContain("agvsr_wait");
    }
    c.close();
  });

  it("records no message when it refuses", async () => {
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "進捗確認です",
    });

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job.id });
    const toDesign = (logs.ok ? logs.result.messages : []).filter((m) => m.to_role === "design");
    expect(toDesign).toHaveLength(1);
    c.close();
  });

  it("allows the next message once the delegate has completed a turn", async () => {
    const { c, job, dispatches, completed, releaseWorkers } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));
    releaseWorkers();
    await waitFor(() => completed.includes("design"));
    // The daemon records the turn just after the runner returns; give it that tick.
    await Bun.sleep(100);

    const again = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "one more thing",
    });
    expect(again.ok).toBe(true);
    c.close();
  });

  it("stands down when AGVSR_DELEGATION_GUARD is disabled", async () => {
    setEnv("AGVSR_DELEGATION_GUARD", "0");
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    const nudge = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "進捗確認です",
    });
    expect(nudge.ok).toBe(true);
    c.close();
  });
});

describe("escalating while a delegate is still starting (D44)", () => {
  it("refuses msg.escalate", async () => {
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    const escalated = await c.request("msg.escalate", {
      from: "supervisor",
      job_id: job.id,
      reason: "design is not responding, it needs restarting",
    });

    expect(escalated.ok).toBe(false);
    if (!escalated.ok) {
      expect(escalated.error.code).toBe("delegation_still_starting");
      expect(escalated.error.message).toContain("design");
      expect(escalated.error.message).toContain("agvsr_wait");
    }
    c.close();
  });

  it("refuses the direct supervisor -> user path too", async () => {
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    const sent = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "user",
      body: "design 担当の再起動が必要です",
    });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error.code).toBe("delegation_still_starting");
    c.close();
  });

  it("allows escalation when nothing has been delegated yet", async () => {
    const { c, job } = await setup();
    // The goal itself is ambiguous — a legitimate question, asked before delegating.
    const escalated = await c.request("msg.escalate", {
      from: "supervisor",
      job_id: job.id,
      reason: "the goal is ambiguous: which database should this target?",
    });
    expect(escalated.ok).toBe(true);
    c.close();
  });

  it("allows escalation once a worker has completed a turn", async () => {
    const { c, job, dispatches, completed, releaseWorkers } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));
    releaseWorkers();
    await waitFor(() => completed.includes("design"));
    // The daemon records the turn just after the runner returns; give it that tick.
    await Bun.sleep(100);

    const escalated = await c.request("msg.escalate", {
      from: "supervisor",
      job_id: job.id,
      reason: "the design raises a question only you can answer",
    });
    expect(escalated.ok).toBe(true);
    c.close();
  });

  it("allows escalation once the wait window has passed", async () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m, min_delegation_wait_ms: 0 }
  design: { adapter: claude-code, model: m }
`);
    const { c, job, dispatches } = await setup(team);
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    const escalated = await c.request("msg.escalate", {
      from: "supervisor",
      job_id: job.id,
      reason: "design really has gone quiet",
    });
    expect(escalated.ok).toBe(true);
    c.close();
  });

  it("leaves a worker escalation to the supervisor alone", async () => {
    const { c, job, dispatches } = await setup();
    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    // qa is blocked on something and says so; that reaches the supervisor, not
    // the human, and is never the failure this guard is about.
    const escalated = await c.request("msg.escalate", {
      from: "qa",
      job_id: job.id,
      reason: "I cannot reach the test database",
    });
    expect(escalated.ok).toBe(true);
    c.close();
  });
});
