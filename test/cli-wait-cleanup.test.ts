import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { Store } from "../src/daemon/store.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

// Each test spawns the real CLI as a subprocess (sometimes twice: report +
// --apply) on top of a real daemon connection; cold `bun run` process starts
// can push this past Bun's default 5s per-test timeout under load.
setDefaultTimeout(20000);

// `cleanup` tests spawn the CLI with cwd set to a throwaway git repo (the
// "main" repo whose worktrees are being inspected), not this checkout, so the
// script path must be absolute rather than relative to whatever cwd is passed.
const CLI_PATH = join(process.cwd(), "src/cli/agvsr.ts");

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
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

interface Harness {
  base: string;
  repo: string;
  worktrees: string;
  sock: string;
  db: string;
  daemon: Daemon;
  client: Client;
  release: () => void;
  dispatches: TurnDispatch[];
  oldWorktreesEnv: string | undefined;
}

async function setupHarness(): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "agvsr-cli-wait-cleanup-"));
  const repo = makeRepo(base);
  const worktrees = join(base, "worktrees");
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatches: TurnDispatch[] = [];

  // provisionWorktree() reads AGVSR_WORKTREES at job.create time (not just at
  // daemon startup), so this must stay set for the harness's whole lifetime —
  // restoring it right after startDaemon() would leak real job worktrees into
  // ~/.config/agvsr/worktrees the moment a test calls job.create.
  const oldWorktreesEnv = process.env.AGVSR_WORKTREES;
  mkdirSync(worktrees, { recursive: true });
  process.env.AGVSR_WORKTREES = worktrees;

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: TEAM,
    interruptRunningJobsOnStart: false,
    turnRunner: async (dispatch) => {
      dispatches.push(dispatch);
      dispatch.onProgress?.();
      await gate; // held open until the test explicitly releases it
      return {
        events: [{ kind: "result", ok: true, text: dispatch.role }],
        outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
      };
    },
  });

  const client = await Client.connect(sock);
  return { base, repo, worktrees, sock, db, daemon, client, release, dispatches, oldWorktreesEnv };
}

async function teardown(h: Harness): Promise<void> {
  h.release();
  h.client.close();
  await h.daemon.close();
  if (h.oldWorktreesEnv === undefined) delete process.env.AGVSR_WORKTREES;
  else process.env.AGVSR_WORKTREES = h.oldWorktreesEnv;
  rmSync(h.base, { recursive: true, force: true });
}

async function createJob(h: Harness, goal = "cli wait/cleanup smoke job"): Promise<Job> {
  const created = await h.client.request<{ job: Job }>("job.create", { goal, cwd: h.repo });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  // Wait for worktree provisioning (happens synchronously in job.create's handler,
  // but poll defensively rather than assume timing).
  for (let i = 0; i < 100; i++) {
    const got = await h.client.request<{ job: Job }>("job.get", { id: created.result.job.id });
    if (got.ok && got.result.job.worktree) return got.result.job;
    await Bun.sleep(5);
  }
  throw new Error("job worktree was never provisioned");
}

async function completeJob(h: Harness, jobId: string): Promise<void> {
  const res = await h.client.request("job.complete", { job_id: jobId, result: "done" });
  expect(res.ok).toBe(true);
}

async function runCli(
  args: string[],
  h: Pick<Harness, "sock" | "db" | "worktrees">,
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  // The daemon under test runs in-process (shares this event loop), so this
  // must be async Bun.spawn, never spawnSync — a synchronous spawn would
  // freeze the event loop the daemon itself needs to answer the child's IPC
  // requests, deadlocking both sides.
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      AGVSR_SOCK: h.sock,
      AGVSR_STORE: h.db,
      AGVSR_WORKTREES: h.worktrees,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("agvsr wait", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await teardown(harness);
    harness = null;
  });

  it("prints TERMINAL and exits 0 once a job reaches a terminal status", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);
    await completeJob(harness, job.id);

    const { code, out, err } = await runCli(
      ["wait", job.id, "--poll-sec", "1", "--timeout-sec", "10"],
      harness,
      process.cwd(),
    );
    expect(err).toBe("");
    expect(out).toContain(`${job.id}\tTERMINAL\tdone`);
    expect(code).toBe(0);
  });

  it("prints APPROVAL_REQUEST and exits 0 when the daemon escalates to the human", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);

    const store = new Store(harness.db);
    store.createMessage({
      job_id: job.id,
      from_role: "supervisor",
      to_role: "user",
      kind: "escalation",
      body: "Please approve the implementation handoff.",
    });
    store.close();

    const { code, out, err } = await runCli(
      ["wait", job.id, "--poll-sec", "1", "--timeout-sec", "10"],
      harness,
      process.cwd(),
    );
    expect(err).toBe("");
    expect(out).toContain(`${job.id}\tAPPROVAL_REQUEST\tsupervisor -> user`);
    expect(out).toContain("Please approve the implementation handoff.");
    expect(code).toBe(0);
  });

  it("prints TIMEOUT and exits 1 when the job keeps running with no approval request", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);

    const { code, out, err } = await runCli(
      ["wait", job.id, "--poll-sec", "1", "--timeout-sec", "2"],
      harness,
      process.cwd(),
    );
    expect(err).toBe("");
    expect(out).toContain(`${job.id}\tTIMEOUT\t`);
    expect(code).toBe(1);
  });
});

describe("agvsr cleanup", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await teardown(harness);
    harness = null;
  });

  it("classifies a done, clean, merged job worktree as SAFE_TO_REMOVE and --apply removes it", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);
    await completeJob(harness, job.id);
    const worktree = job.worktree!;
    const branch = job.branch!;

    const report = await runCli(["cleanup"], harness, harness.repo);
    expect(report.err).toBe("");
    expect(report.out).toContain(`${worktree}\tSAFE_TO_REMOVE\t${job.id}\tdone`);

    const applied = await runCli(["cleanup", "--apply"], harness, harness.repo);
    expect(applied.out).toContain(`removed ${worktree} (branch ${branch})`);

    const list = git(harness.repo, ["worktree", "list"]);
    expect(list.stdout).not.toContain(worktree);
    const branchList = git(harness.repo, ["branch", "--list", branch]);
    expect(branchList.stdout).toBe("");
  });

  it("classifies a running job's worktree as KEEP and never removes it", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);
    const worktree = job.worktree!;

    const report = await runCli(["cleanup"], harness, harness.repo);
    expect(report.out).toContain(`${worktree}\tKEEP\t${job.id}\trunning`);

    await runCli(["cleanup", "--apply"], harness, harness.repo);
    const list = git(harness.repo, ["worktree", "list"]);
    expect(list.stdout).toContain(worktree);
  });

  it("classifies a dirty worktree as NEEDS_REVIEW and does not remove it with --apply", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);
    await completeJob(harness, job.id);
    const worktree = job.worktree!;
    writeFileSync(join(worktree, "leftover.txt"), "uncommitted");

    const report = await runCli(["cleanup"], harness, harness.repo);
    expect(report.out).toContain("NEEDS_REVIEW");
    expect(report.out).toContain("uncommitted changes in the worktree");

    await runCli(["cleanup", "--apply"], harness, harness.repo);
    const list = git(harness.repo, ["worktree", "list"]);
    expect(list.stdout).toContain(worktree);
  });

  it("classifies an unmerged branch as NEEDS_REVIEW", async () => {
    harness = await setupHarness();
    const job = await createJob(harness);
    await completeJob(harness, job.id);
    const worktree = job.worktree!;
    writeFileSync(join(worktree, "extra.txt"), "extra work");
    git(worktree, ["add", "extra.txt"]);
    git(worktree, ["commit", "-m", "unmerged follow-up commit"]);

    const report = await runCli(["cleanup"], harness, harness.repo);
    expect(report.out).toContain("NEEDS_REVIEW");
    expect(report.out).toContain("commit(s) not yet merged into main");
  });

  it("treats a worktree with no matching job record as an orphan and removes it when clean+merged", async () => {
    harness = await setupHarness();
    const orphanPath = join(harness.base, "orphan-wt");
    git(harness.repo, ["worktree", "add", "-b", "orphan-branch", orphanPath, "HEAD"]);

    const report = await runCli(["cleanup"], harness, harness.repo);
    expect(report.out).toContain(`${orphanPath}\tSAFE_TO_REMOVE\t-\tORPHAN`);

    await runCli(["cleanup", "--apply"], harness, harness.repo);
    const list = git(harness.repo, ["worktree", "list"]);
    expect(list.stdout).not.toContain(orphanPath);
  });
});
