import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { formatJobUsage } from "../src/cli/agvsr.ts";
import type { TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
`);

/**
 * Daemon whose supervisor turns are scripted: each entry is either an escalation
 * to the human (routes a message) or an idle turn (assistant text, no routing).
 * Once the script runs out, every further turn is idle.
 */
async function makeDaemon(script: Array<"escalate" | "idle">) {
  const base = join(tmpdir(), `agvsr-idle-${randomUUID()}`);
  const sock = `${base}.sock`;
  const db = `${base}.sqlite`;
  const repo = `${base}-repo`;
  mkdirSync(repo, { recursive: true });
  const turns: TurnDispatch[] = [];
  let step = 0;

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: TEAM,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d: TurnDispatch) => {
      turns.push(d);
      const action = script[step++] ?? "idle";
      if (action === "escalate") {
        const c = await Client.connect(sock);
        await c.request("msg.escalate", {
          from: d.role,
          job_id: d.job.id,
          reason: "Need the human to run bun install",
        });
        c.close();
      }
      return {
        events: [],
        outcome: {
          sessionId: `${d.role}-s`,
          finalText: "Already escalated; waiting for the human.",
          exitCode: 0,
        },
      };
    },
  });
  return { daemon, sock, db, repo, turns };
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

async function waitFor(check: () => Promise<boolean>, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
}

async function statusOf(c: Client, jobId: string): Promise<string> {
  const got = await c.request<{ job: Job }>("job.get", { id: jobId });
  return got.ok ? got.result.job.status : "unknown";
}

async function messagesOf(c: Client, jobId: string): Promise<Message[]> {
  const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
  return logs.ok ? logs.result.messages : [];
}

describe("supervisor idle turns (D36)", () => {
  it("keeps the job running when the supervisor is waiting on an unanswered escalation", async () => {
    // The reported bug: escalate, then get one more turn (a worker reporting in),
    // end it with text only — the job used to hard-fail on the spot.
    const h = await makeDaemon(["escalate", "idle", "idle", "idle", "idle"]);
    const c = await Client.connect(h.sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "waits", cwd: h.repo });
    const jobId = created.ok ? created.result.job.id : "";

    await waitFor(async () =>
      (await messagesOf(c, jobId)).some(
        (m) => m.from_role === "supervisor" && m.to_role === "user",
      ),
    );
    const msgs = await messagesOf(c, jobId);
    expect(msgs.some((m) => m.from_role === "supervisor" && m.to_role === "user")).toBe(true);

    // Feed several more turns while the question is still outstanding.
    for (let i = 0; i < 4; i++) {
      await c.request("msg.send", {
        from: "implementation",
        job_id: jobId,
        to: "supervisor",
        body: `progress ping ${i}`,
      });
    }
    await waitFor(async () => h.turns.length >= 4);
    await Bun.sleep(100);

    expect(await statusOf(c, jobId)).toBe("running");
    const after = await messagesOf(c, jobId);
    expect(after.some((m) => m.kind === "failure")).toBe(false);
    // And it was not nudged either — waiting is not something to be corrected.
    expect(after.some((m) => m.kind === "escalation" && m.to_role === "supervisor")).toBe(false);

    c.close();
    await h.daemon.close();
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });

  it("nudges an idle supervisor before failing, when nothing is outstanding", async () => {
    const h = await makeDaemon(["idle", "idle", "idle", "idle"]);
    const c = await Client.connect(h.sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "idles", cwd: h.repo });
    const jobId = created.ok ? created.result.job.id : "";

    await waitFor(async () => (await statusOf(c, jobId)) === "failed");
    expect(await statusOf(c, jobId)).toBe("failed");

    const msgs = await messagesOf(c, jobId);
    const nudges = msgs.filter((m) => m.kind === "escalation" && m.to_role === "supervisor");
    // Two nudges, then the third idle turn fails the job (MAX = 3).
    expect(nudges).toHaveLength(2);
    expect(nudges[0]?.body).toContain("agvsr_status is read-only");
    const failure = msgs.find((m) => m.kind === "failure");
    expect(failure?.body).toContain("3 consecutive turns");
    // The old wording blamed a missing tool call, which was never what was checked.
    expect(failure?.body).not.toContain("no agvsr tool call was recorded");

    c.close();
    await h.daemon.close();
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });

  it("resumes counting idle turns once the human has answered", async () => {
    const h = await makeDaemon(["escalate"]);
    const c = await Client.connect(h.sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "answered", cwd: h.repo });
    const jobId = created.ok ? created.result.job.id : "";
    await waitFor(async () => h.turns.length >= 1);

    // Still waiting: idle turns are tolerated.
    await c.request("msg.send", {
      from: "implementation",
      job_id: jobId,
      to: "supervisor",
      body: "ping",
    });
    await waitFor(async () => h.turns.length >= 2);
    expect(await statusOf(c, jobId)).toBe("running");

    // The human answers — now the supervisor owns the next move again, so further
    // idle turns are a real stall and the job is failed.
    await c.request("job.tell", { job_id: jobId, body: "done, retry the install" });
    await waitFor(async () => (await statusOf(c, jobId)) === "failed");
    expect(await statusOf(c, jobId)).toBe("failed");

    c.close();
    await h.daemon.close();
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });

  it("clears the idle count when the supervisor routes again", async () => {
    // idle, idle would be one short of failing; the escalation in between resets it,
    // so the job survives turns that would otherwise have crossed the threshold.
    const h = await makeDaemon(["idle", "idle", "escalate"]);
    const c = await Client.connect(h.sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "recovers", cwd: h.repo });
    const jobId = created.ok ? created.result.job.id : "";

    await waitFor(async () => h.turns.length >= 3);
    await Bun.sleep(150);
    expect(await statusOf(c, jobId)).toBe("running");
    const msgs = await messagesOf(c, jobId);
    expect(msgs.some((m) => m.kind === "failure")).toBe(false);

    c.close();
    await h.daemon.close();
    cleanup(h.sock, h.db, `${h.db}-wal`, `${h.db}-shm`, h.repo);
  });
});

describe("formatJobUsage against an older daemon", () => {
  it("renders the empty block instead of crashing when job.get sends no usage", () => {
    // A daemon predating the accounting feature answers job.get without `usage`,
    // and the CLI is routinely newer than the daemon it talks to.
    expect(formatJobUsage(undefined)).toEqual(["usage: (none recorded)"]);
    expect(formatJobUsage({} as never)).toEqual(["usage: (none recorded)"]);
  });

  it("survives a payload with totals but no by_role array", () => {
    const usage = {
      totals: {
        turns: 1,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: 1,
        cost_partial: false,
      },
    } as never;
    expect(formatJobUsage(usage)).toEqual([expect.stringContaining("1 turns")]);
  });
});
