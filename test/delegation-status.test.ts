/**
 * Delegation status injected into supervisor turns (D44 mechanism A).
 *
 * The supervisor that escalated "design is not responding" 30 seconds after
 * delegating could not tell "has not answered" from "has not started". These
 * tests pin that the daemon now states which one it is, in its own words.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  design: { adapter: claude-code, model: m }
  qa: { adapter: agy, model: m }
`);

const trash: string[] = [];
let openDaemon: Daemon | null = null;
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

async function setup() {
  const base = join(tmpdir(), `agvsr-delegstatus-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  const held: Array<() => void> = [];
  const dispatches: TurnDispatch[] = [];
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
    team: TEAM,
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

async function waitFor(check: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
}

const supervisorTurns = (dispatches: TurnDispatch[]) =>
  dispatches.filter((d) => d.role === "supervisor");

describe("delegation status block (D44 mechanism A)", () => {
  it("reaches the supervisor's very first turn", async () => {
    const { c, dispatches } = await setup();
    await waitFor(() => supervisorTurns(dispatches).length > 0);

    const first = supervisorTurns(dispatches)[0]!;
    expect(first.message).toContain("[agvsr delegation status]");
    // Nothing has been delegated yet, and the block says exactly that.
    expect(first.message).toContain("design");
    expect(first.message).toContain("not delegated");
    // The goal itself is still there, after the block.
    expect(first.message).toContain("g");
    c.close();
  });

  it("distinguishes a delegate that has not started from one that has not answered", async () => {
    const { c, job, dispatches, completed, releaseWorkers } = await setup();
    await waitFor(() => supervisorTurns(dispatches).length > 0);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    releaseWorkers();
    await waitFor(() => completed.includes("design"));
    // The stub worker routes nothing, so nudge the supervisor into a fresh turn
    // to read the block off it.
    const before = supervisorTurns(dispatches).length;
    await c.request("job.tell", { job_id: job.id, body: "carry on" });
    await waitFor(() => supervisorTurns(dispatches).length > before);

    const latest = supervisorTurns(dispatches).at(-1)!;
    expect(latest.message).toContain("[agvsr delegation status]");
    expect(latest.message).toMatch(/design\s+:.*1 turn\(s\) completed/);
    // qa was never delegated, and is reported separately from design.
    expect(latest.message).toMatch(/qa\s+:\s*not delegated/);
    c.close();
  });

  it("reports an outstanding delegation with its age", async () => {
    const { c, job, dispatches } = await setup();
    await waitFor(() => supervisorTurns(dispatches).length > 0);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    // A message from the human re-dispatches the supervisor while design is held.
    await c.request("job.tell", { job_id: job.id, body: "one clarification: use postgres" });
    await waitFor(() => supervisorTurns(dispatches).length > 1);

    const latest = supervisorTurns(dispatches).at(-1)!;
    expect(latest.message).toMatch(/design\s+:\s*awaiting reply, delegated .* ago/);
    expect(latest.message).toMatch(/design\s+:.*0 turn\(s\) completed/);
    expect(latest.message).toMatch(/design\s+:.*in-flight: yes/);
    c.close();
  });

  it("is not prepended to worker turns", async () => {
    const { c, job, dispatches, releaseWorkers } = await setup();
    await waitFor(() => supervisorTurns(dispatches).length > 0);
    releaseWorkers();

    await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "design",
      body: "please design this",
    });
    await waitFor(() => dispatches.some((d) => d.role === "design"));

    const designTurn = dispatches.find((d) => d.role === "design")!;
    expect(designTurn.message).not.toContain("[agvsr delegation status]");
    expect(designTurn.message).toContain("please design this");
    c.close();
  });

  it("stands down when AGVSR_DELEGATION_GUARD is disabled", async () => {
    setEnv("AGVSR_DELEGATION_GUARD", "0");
    const { c, dispatches } = await setup();
    await waitFor(() => supervisorTurns(dispatches).length > 0);

    expect(supervisorTurns(dispatches)[0]!.message).not.toContain("[agvsr delegation status]");
    c.close();
  });
});
