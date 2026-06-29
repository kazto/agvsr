import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";
import { checkJobCommitGate } from "../src/git/commit-gate.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
`);

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function makeRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "hello");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, ["add", "tracked.txt", ".gitignore"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function waitForDispatches(dispatches: TurnDispatch[], n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (dispatches.length >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`expected ${n} dispatches, got ${dispatches.length}`);
}

describe("commit gate", () => {
  const base = join(tmpdir(), `agvsr-commit-gate-${randomUUID()}`);
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");
  const configDir = join(base, "config");
  let daemon: Daemon | null = null;
  const dispatches: TurnDispatch[] = [];

  beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = configDir;
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: sock,
      storeFile: db,
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        dispatches.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: `ok ${dispatch.role}` }],
          outcome: {
            sessionId: `${dispatch.role}-${randomUUID()}`,
            finalText: "",
            exitCode: 0,
          },
        };
      },
    });
  });

  afterAll(async () => {
    if (daemon) await daemon.close();
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.AGVSR_COMMIT_GATE;
    for (const f of [sock, db, `${db}-wal`, `${db}-shm`, base]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {}
    }
  });

  async function createJob(cwd: string): Promise<{ c: Client; job: Job }> {
    const before = dispatches.length;
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "ship it",
      cwd,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");
    await waitForDispatches(dispatches, before + 1);
    return { c, job: created.result.job };
  }

  it("rejects completion for a dirty worktree and leaves the job running", async () => {
    const repo = makeRepo(join(base, "dirty"));
    const { c, job } = await createJob(repo);
    expect(job.worktree).not.toBeNull();
    if (!job.worktree) throw new Error("missing worktree");
    writeFileSync(join(job.worktree, "tracked.txt"), "modified");

    const blocked = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("commit_required");

    const got = await c.request<{ job: Job }>("job.get", { id: job.id });
    expect(got.ok && got.result.job.status).toBe("running");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job.id });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.kind === "completion")).toBe(false);
    expect(
      logs.result.messages.some(
        (m) => m.kind === "escalation" && m.from_role === "daemon" && /commit/i.test(m.body),
      ),
    ).toBe(true);

    c.close();
  });

  it("accepts completion after the worktree changes are committed", async () => {
    const repo = makeRepo(join(base, "committed"));
    const { c, job } = await createJob(repo);
    expect(job.worktree).not.toBeNull();
    if (!job.worktree) throw new Error("missing worktree");
    writeFileSync(join(job.worktree, "tracked.txt"), "modified");
    git(job.worktree, ["add", "tracked.txt"]);
    git(job.worktree, ["commit", "-m", "commit changes"]);

    const done = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(done.ok).toBe(true);

    const got = await c.request<{ job: Job }>("job.get", { id: job.id });
    expect(got.ok && got.result.job.status).toBe("done");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job.id });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");
    expect(logs.result.messages.some((m) => m.kind === "completion" && m.body === "done")).toBe(
      true,
    );

    c.close();
  });

  it("passes when the gate is disabled even if the worktree is dirty", async () => {
    process.env.AGVSR_COMMIT_GATE = "off";
    const repo = makeRepo(join(base, "disabled"));
    const { c, job } = await createJob(repo);
    expect(job.worktree).not.toBeNull();
    if (!job.worktree) throw new Error("missing worktree");
    writeFileSync(join(job.worktree, "tracked.txt"), "modified");

    const done = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(done.ok).toBe(true);
    c.close();
    delete process.env.AGVSR_COMMIT_GATE;
  });

  it("allows completion when only ignored files exist in the worktree", async () => {
    const repo = makeRepo(join(base, "ignored"));
    const { c, job } = await createJob(repo);
    expect(job.worktree).not.toBeNull();
    if (!job.worktree) throw new Error("missing worktree");
    writeFileSync(join(job.worktree, "ignored.txt"), "ignored content");

    const status = git(job.worktree, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    expect(status.stdout).toBe("");
    expect(checkJobCommitGate(job).ok).toBe(true);

    const done = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(done.ok).toBe(true);
    c.close();
  });

  it("reports commit_check_failed when the worktree is not a git repository", () => {
    const notARepo = join(base, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });

    const gate = checkJobCommitGate({ id: "job-no-git", worktree: notARepo });
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected the gate to block");
    expect(gate.code).toBe("commit_check_failed");
    expect(gate.message).toContain(notARepo);
  });
});
