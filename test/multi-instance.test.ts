import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation:
    - { adapter: codex, model: gpt-5.5 }
    - { adapter: claude-code, model: claude-opus-4-8 }
`);

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function makeRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "hello");
  git(repo, ["add", "tracked.txt"]);
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

describe("array-valued implementation: per-instance worktree isolation (D27)", () => {
  const base = join(tmpdir(), `agvsr-multi-instance-${randomUUID()}`);
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
          outcome: { sessionId: `${dispatch.role}-${randomUUID()}`, finalText: "", exitCode: 0 },
        };
      },
    });
  });

  afterAll(async () => {
    if (daemon) await daemon.close();
    delete process.env.XDG_CONFIG_HOME;
    for (const f of [sock, db, `${db}-wal`, `${db}-shm`, base]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {}
    }
  });

  it("provisions a dedicated worktree per instance, distinct from the job's own", async () => {
    const repo = makeRepo(join(base, "provision"));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "build it", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");
    const job = created.result.job;

    expect(job.worktree).not.toBeNull();
    const instance1 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-1`);
    const instance2 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-2`);
    expect(existsSync(instance1)).toBe(true);
    expect(existsSync(instance2)).toBe(true);
    expect(instance1).not.toBe(job.worktree);
    expect(instance2).not.toBe(job.worktree);

    // Each instance is its own git worktree on its own branch.
    const branch1 = git(instance1, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch1.stdout).toBe(`${job.branch}--implementation-1`);

    c.close();
  });

  it("dispatches each instance to its own worktree (effectiveCwd), not the job's", async () => {
    const repo = makeRepo(join(base, "dispatch"));
    const before = dispatches.length;
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "build it", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");
    const job = created.result.job;
    await waitForDispatches(dispatches, before + 1); // supervisor's initial turn

    const sent = await c.request("msg.send", {
      from: "supervisor",
      job_id: job.id,
      to: "implementation-1",
      body: "go",
    });
    expect(sent.ok).toBe(true);
    await waitForDispatches(dispatches, before + 2);

    const implDispatch = dispatches.find((d) => d.role === "implementation-1");
    expect(implDispatch).toBeDefined();
    expect(implDispatch!.effectiveCwd).not.toBe(job.worktree);
    expect(implDispatch!.effectiveCwd).toContain(`${job.id}--implementation-1`);

    c.close();
  });

  it("blocks job.complete on a dirty instance worktree even when the job worktree is clean", async () => {
    const repo = makeRepo(join(base, "dirty-instance"));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "build it", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");
    const job = created.result.job;

    const instance1 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-1`);
    expect(existsSync(instance1)).toBe(true);
    writeFileSync(join(instance1, "tracked.txt"), "dirtied by instance");

    // The job's own worktree is untouched/clean.
    const blocked = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("commit_required");

    // Commit the instance's work; completion should now succeed.
    git(instance1, ["add", "tracked.txt"]);
    git(instance1, ["commit", "-m", "instance work"]);
    const done = await c.request("job.complete", { job_id: job.id, result: "done" });
    expect(done.ok).toBe(true);

    c.close();
  });
});

describe("job.mergeInstance (supervisor reconciles instance branches, D27)", () => {
  const base = join(tmpdir(), `agvsr-merge-instance-${randomUUID()}`);
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");
  const configDir = join(base, "config");
  let daemon: Daemon | null = null;

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
      turnRunner: async (dispatch) => ({
        events: [{ kind: "result", ok: true, text: `ok ${dispatch.role}` }],
        outcome: { sessionId: `${dispatch.role}-${randomUUID()}`, finalText: "", exitCode: 0 },
      }),
    });
  });

  afterAll(async () => {
    if (daemon) await daemon.close();
    delete process.env.XDG_CONFIG_HOME;
    for (const f of [sock, db, `${db}-wal`, `${db}-shm`, base]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {}
    }
  });

  async function createJob(cwd: string): Promise<{ c: Client; job: Job }> {
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "build it", cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");
    return { c, job: created.result.job };
  }

  it("merges a clean instance branch into the job branch", async () => {
    const repo = makeRepo(join(base, "clean-merge"));
    const { c, job } = await createJob(repo);
    const instance1 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-1`);
    writeFileSync(join(instance1, "new-file.txt"), "from instance 1");
    git(instance1, ["add", "new-file.txt"]);
    git(instance1, ["commit", "-m", "instance 1 work"]);

    const merged = await c.request<{ summary: string }>("job.mergeInstance", {
      job_id: job.id,
      role: "implementation-1",
    });
    expect(merged.ok).toBe(true);

    expect(existsSync(join(job.worktree!, "new-file.txt"))).toBe(true);
    const log = git(job.worktree!, ["log", "--oneline", "-1"]);
    expect(log.stdout).toContain("Merge agvsr/");

    c.close();
  });

  it("rejects merging when the instance itself has uncommitted work", async () => {
    const repo = makeRepo(join(base, "dirty-source"));
    const { c, job } = await createJob(repo);
    const instance1 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-1`);
    writeFileSync(join(instance1, "uncommitted.txt"), "oops");

    const result = await c.request("job.mergeInstance", {
      job_id: job.id,
      role: "implementation-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("uncommitted work");

    c.close();
  });

  it("aborts cleanly and reports conflicting files on a real conflict", async () => {
    const repo = makeRepo(join(base, "conflict"));
    const { c, job } = await createJob(repo);
    const instance1 = join(configDir, "agvsr", "worktrees", `${job.id}--implementation-1`);

    // Conflicting edits to the same tracked file on both the job branch and the instance branch.
    writeFileSync(join(job.worktree!, "tracked.txt"), "job branch edit");
    git(job.worktree!, ["add", "tracked.txt"]);
    git(job.worktree!, ["commit", "-m", "job branch edit"]);

    writeFileSync(join(instance1, "tracked.txt"), "instance edit");
    git(instance1, ["add", "tracked.txt"]);
    git(instance1, ["commit", "-m", "instance edit"]);

    const result = await c.request<{ conflicts: string[] }>("job.mergeInstance", {
      job_id: job.id,
      role: "implementation-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("conflict");
      expect(result.error.message).toContain("tracked.txt");
    }

    // The job worktree is left clean (merge was aborted), not half-merged.
    const status = git(job.worktree!, ["status", "--porcelain"]);
    expect(status.stdout).toBe("");

    c.close();
  });

  it("errors for an unknown instance role", async () => {
    const repo = makeRepo(join(base, "unknown-role"));
    const { c, job } = await createJob(repo);

    const result = await c.request("job.mergeInstance", {
      job_id: job.id,
      role: "implementation-99",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");

    c.close();
  });
});
