/**
 * Worktree isolation tests.
 * Covers: store migration, worktree creation, file replication,
 * failure behavior, daemon effective cwd, CLI status visibility.
 * Uses real git repo fixtures (no mocking of git operations).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { Store } from "../src/daemon/store.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";
import { provisionWorktree } from "../src/git/worktree.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

/** Build a git repo with one tracked file, one untracked non-ignored file, one ignored file. */
function makeGitFixture(base: string): {
  repo: string;
  tracked: string;
  untracked: string;
  ignored: string;
} {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);

  // tracked: committed file
  const tracked = join(repo, "tracked.txt");
  writeFileSync(tracked, "hello tracked");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);

  // untracked non-ignored
  const untracked = join(repo, "untracked.txt");
  writeFileSync(untracked, "hello untracked");

  // ignored via .gitignore
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  const ignored = join(repo, "ignored.txt");
  writeFileSync(ignored, "should not copy");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-m", "add gitignore"]);

  return { repo, tracked, untracked, ignored };
}

// ---------------------------------------------------------------------------
// 1. Store migration: existing rows survive
// ---------------------------------------------------------------------------

describe("Store — worktree migration", () => {
  it("existing rows created before the worktree column survive migration", () => {
    const dbPath = join(tmpdir(), `agvsr-migration-${randomUUID()}.sqlite`);

    // Seed the DB *without* the worktree column (simulate pre-feature row)
    const { Database } = require("bun:sqlite");
    const raw = new Database(dbPath, { create: true });
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        cwd TEXT NOT NULL,
        branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const ts = new Date().toISOString();
    raw.exec(
      `INSERT INTO jobs (id, goal, status, cwd, branch, created_at, updated_at)
       VALUES ('legacy-job', 'old goal', 'running', '/old', 'agvsr/legacy', '${ts}', '${ts}')`,
    );
    raw.close();

    // Open via Store — migration runs
    const store = new Store(dbPath);
    const job = store.getJob("legacy-job");
    expect(job).not.toBeNull();
    expect(job!.id).toBe("legacy-job");
    expect(job!.goal).toBe("old goal");
    expect(job!.worktree).toBeNull(); // pre-migration row has null worktree

    // New jobs also work
    const newJob = store.createJob("new goal", "/new", "new-job");
    expect(newJob.worktree).toBeNull();
    const fetched = store.getJob("new-job");
    expect(fetched!.worktree).toBeNull();

    store.close();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {}
  });

  it("setJobWorktree persists across store re-open", () => {
    const dbPath = join(tmpdir(), `agvsr-worktree-persist-${randomUUID()}.sqlite`);
    const store = new Store(dbPath);
    const job = store.createJob("persist test", "/repo");
    store.setJobWorktree(job.id, "/wt/path");

    const fetched = store.getJob(job.id);
    expect(fetched!.worktree).toBe("/wt/path");

    store.close();

    // Re-open — value must survive
    const store2 = new Store(dbPath);
    const fetched2 = store2.getJob(job.id);
    expect(fetched2!.worktree).toBe("/wt/path");
    store2.close();

    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        rmSync(f);
      } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// 2. provisionWorktree — low-level function tests
// ---------------------------------------------------------------------------

describe("provisionWorktree", () => {
  const base = join(tmpdir(), `agvsr-wt-${randomUUID()}`);
  const customConfigDir = join(base, "config");

  beforeAll(() => {
    mkdirSync(base, { recursive: true });
    mkdirSync(customConfigDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = customConfigDir;
  });

  afterAll(() => {
    delete process.env.XDG_CONFIG_HOME;
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {}
  });

  it("returns null for a non-git directory", async () => {
    const nonGit = join(base, "not-a-repo");
    mkdirSync(nonGit, { recursive: true });
    const result = await provisionWorktree(nonGit, "job-1", "agvsr/job-1");
    expect(result).toBeNull();
  });

  it("returns null for an empty (unborn) git repo", async () => {
    const emptyRepo = join(base, "empty-repo");
    mkdirSync(emptyRepo, { recursive: true });
    git(emptyRepo, ["init"]);
    const result = await provisionWorktree(emptyRepo, "job-empty", "agvsr/empty");
    expect(result).toBeNull();
  });

  it("creates a worktree at configDir()/worktrees/<jobId> for a git repo with commits", async () => {
    const { repo } = makeGitFixture(join(base, "fixture-create"));
    const jobId = `job-${randomUUID()}`;
    const result = await provisionWorktree(repo, jobId, `agvsr/${jobId}`);
    expect(result).not.toBeNull();
    expect(result).toContain(jobId);
    expect(existsSync(result!)).toBe(true);
  });

  it("replicates tracked committed files into the worktree", async () => {
    const { repo } = makeGitFixture(join(base, "fixture-tracked"));
    const jobId = `job-${randomUUID()}`;
    const worktreePath = await provisionWorktree(repo, jobId, `agvsr/${jobId}`);
    expect(worktreePath).not.toBeNull();
    const content = readFileSync(join(worktreePath!, "tracked.txt"), "utf8");
    expect(content).toBe("hello tracked");
  });

  it("replicates untracked non-ignored files into the worktree", async () => {
    const { repo } = makeGitFixture(join(base, "fixture-untracked"));
    const jobId = `job-${randomUUID()}`;
    const worktreePath = await provisionWorktree(repo, jobId, `agvsr/${jobId}`);
    expect(worktreePath).not.toBeNull();
    expect(existsSync(join(worktreePath!, "untracked.txt"))).toBe(true);
    const content = readFileSync(join(worktreePath!, "untracked.txt"), "utf8");
    expect(content).toBe("hello untracked");
  });

  it("does not copy gitignored files into the worktree", async () => {
    const { repo } = makeGitFixture(join(base, "fixture-ignored"));
    const jobId = `job-${randomUUID()}`;
    const worktreePath = await provisionWorktree(repo, jobId, `agvsr/${jobId}`);
    expect(worktreePath).not.toBeNull();
    expect(existsSync(join(worktreePath!, "ignored.txt"))).toBe(false);
  });

  it("throws when git worktree add fails (e.g., branch already exists)", async () => {
    const { repo } = makeGitFixture(join(base, "fixture-fail"));
    const branch = `agvsr/duplicate-${randomUUID()}`;
    // Pre-create the branch to force git worktree add to fail
    git(repo, ["branch", branch]);
    await expect(provisionWorktree(repo, "dup-job", branch)).rejects.toThrow(
      "git worktree add failed",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Daemon integration: worktree provisioning via job.create
// ---------------------------------------------------------------------------

describe("Daemon — worktree via job.create", () => {
  const base = join(tmpdir(), `agvsr-daemon-wt-${randomUUID()}`);
  const customConfigDir = join(base, "config");
  let daemon: Daemon | null = null;
  const dispatches: TurnDispatch[] = [];

  beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    mkdirSync(customConfigDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = customConfigDir;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: join(base, "daemon.sock"),
      storeFile: join(base, "store.sqlite"),
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        dispatches.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: "" }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
  });

  afterAll(async () => {
    if (daemon) await daemon.close();
    delete process.env.XDG_CONFIG_HOME;
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {}
  });

  async function waitForDispatch(n: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (dispatches.length >= n) return;
      await Bun.sleep(10);
    }
    throw new Error(`expected ${n} dispatches, got ${dispatches.length}`);
  }

  it("creates worktree=null for a non-git cwd (backward compat)", async () => {
    const nonGit = join(base, "non-git");
    mkdirSync(nonGit, { recursive: true });
    const c = await Client.connect(join(base, "daemon.sock"));
    const res = await c.request<{ job: Job }>("job.create", {
      goal: "non-git job",
      cwd: nonGit,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("job.create failed");
    expect(res.result.job.worktree).toBeNull();
    c.close();
  });

  it("creates a worktree and stores it on the job for a git repo", async () => {
    const { repo } = makeGitFixture(join(base, "git-fixture"));
    const before = dispatches.length;
    const c = await Client.connect(join(base, "daemon.sock"));
    const res = await c.request<{ job: Job }>("job.create", {
      goal: "git job",
      cwd: repo,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("job.create failed");
    const job = res.result.job;
    expect(job.worktree).not.toBeNull();
    expect(job.worktree).toContain(job.id);
    expect(existsSync(job.worktree!)).toBe(true);

    // Persisted: job.get returns same worktree
    const got = await c.request<{ job: Job }>("job.get", { id: job.id });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("job.get failed");
    expect(got.result.job.worktree).toBe(job.worktree);

    await waitForDispatch(before + 1);
    c.close();
  });

  it("daemon dispatches turn with effectiveCwd = worktree path for git jobs", async () => {
    const { repo } = makeGitFixture(join(base, "git-fixture-cwd"));
    const before = dispatches.length;
    const c = await Client.connect(join(base, "daemon.sock"));
    const res = await c.request<{ job: Job }>("job.create", {
      goal: "cwd check",
      cwd: repo,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("job.create failed");
    const job = res.result.job;
    const worktree = job.worktree;
    expect(worktree).not.toBeNull();
    if (!worktree) throw new Error("expected worktree path");

    await waitForDispatch(before + 1);
    const dispatch = dispatches.at(-1)!;
    expect(dispatch.effectiveCwd).toBe(worktree);
    expect(dispatch.effectiveCwd).not.toBe(job.cwd); // isolated, not source dir
    c.close();
  });

  it("daemon dispatches turn with effectiveCwd = cwd for non-git jobs", async () => {
    const nonGit = join(base, "non-git-cwd");
    mkdirSync(nonGit, { recursive: true });
    const before = dispatches.length;
    const c = await Client.connect(join(base, "daemon.sock"));
    const res = await c.request<{ job: Job }>("job.create", {
      goal: "non-git cwd check",
      cwd: nonGit,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("job.create failed");
    const job = res.result.job;
    expect(job.worktree).toBeNull();

    await waitForDispatch(before + 1);
    const dispatch = dispatches.at(-1)!;
    expect(dispatch.effectiveCwd).toBe(job.cwd);
    c.close();
  });

  it("job.create fails when git worktree provisioning fails and leaves no running job", async () => {
    const { repo } = makeGitFixture(join(base, "git-fixture-fail"));
    // A UUID custom id: provisioning will use branch agvsr/<customId>
    // Pre-create that branch to force failure
    const customId = `fail-${randomUUID()}`;
    const branch = `agvsr/${customId}`;
    git(repo, ["branch", branch]);

    const c = await Client.connect(join(base, "daemon.sock"));
    const res = await c.request("job.create", {
      goal: "will fail provisioning",
      cwd: repo,
      id: customId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("provisioning_failed");

    // The job should be in the store but marked failed, not running
    const got = await c.request<{ job: Job }>("job.get", { id: customId });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("job.get failed");
    expect(got.result.job.status).toBe("failed");
    c.close();
  });

  it("worktree path persists across daemon restart", async () => {
    const { repo } = makeGitFixture(join(base, "git-fixture-restart"));
    const c1 = await Client.connect(join(base, "daemon.sock"));
    const res = await c1.request<{ job: Job }>("job.create", {
      goal: "restart test",
      cwd: repo,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("job.create failed");
    const jobId = res.result.job.id;
    const worktree = res.result.job.worktree;
    expect(worktree).not.toBeNull();
    c1.close();
    await daemon!.close();
    daemon = null;

    // Restart daemon against same store
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: join(base, "daemon-r2.sock"),
      storeFile: join(base, "store.sqlite"),
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (d) => ({
        events: [],
        outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
      }),
    });
    const c2 = await Client.connect(join(base, "daemon-r2.sock"));
    const got = await c2.request<{ job: Job }>("job.get", { id: jobId });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("job.get failed");
    expect(got.result.job.worktree).toBe(worktree);
    c2.close();
  });
});

// ---------------------------------------------------------------------------
// 4. CLI status visibility
// ---------------------------------------------------------------------------

describe("status CLI — worktree visibility", () => {
  it("status output source includes worktree field", () => {
    const src = readFileSync(new URL("../src/cli/agvsr.ts", import.meta.url).pathname, "utf8");
    expect(src).toContain('console.log(`worktree: ${job.worktree ?? "(none)"}`');
  });
});
