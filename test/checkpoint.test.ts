/**
 * Turn-end worktree checkpoints (D46 mechanisms B and C).
 *
 * Real git throughout. The property under test is "uncommitted work survives
 * removal of the worktree holding it", which only git can actually witness.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import {
  capturingRef,
  checkpointRef,
  createCheckpoint,
  isCapturedAt,
  snapshotTree,
} from "../src/git/checkpoint.ts";
import { assessWorktree } from "../src/git/cleanup.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  design: { adapter: claude-code, model: m }
`);

const trash: string[] = [];
let openDaemon: Daemon | null = null;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
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

/** A repo with one commit and a gitignored dependency dir. */
function makeRepo(): string {
  const base = join(tmpdir(), `agvsr-checkpoint-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

describe("snapshotTree", () => {
  it("captures an untracked file — what git stash create drops", () => {
    const repo = makeRepo();
    const clean = snapshotTree(repo);
    writeFileSync(join(repo, "design.md"), "# design\n");
    expect(snapshotTree(repo)).not.toBe(clean);
    // The precise failure this exists for: `git stash create` sees nothing here.
    expect(git(repo, ["stash", "create"]).stdout).toBe("");
  });

  it("excludes gitignored paths", () => {
    const repo = makeRepo();
    const before = snapshotTree(repo);
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "junk.js"), "x\n");
    expect(snapshotTree(repo)).toBe(before);
  });

  it("leaves the worktree and its index untouched", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    writeFileSync(join(repo, "README.md"), "changed\n");
    const statusBefore = git(repo, ["status", "--porcelain"]).stdout;
    snapshotTree(repo);
    expect(git(repo, ["status", "--porcelain"]).stdout).toBe(statusBefore);
  });

  it("returns null for a directory that is not a checkout", () => {
    const plain = join(tmpdir(), `agvsr-cp-plain-${randomUUID()}`);
    trash.push(plain);
    mkdirSync(plain, { recursive: true });
    expect(snapshotTree(plain)).toBeNull();
  });
});

describe("createCheckpoint", () => {
  it("parks uncommitted work off any branch and keeps it reachable", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);

    const cp = createCheckpoint(repo, ref);
    expect(cp).not.toBeNull();
    // Reachable through the ref, and carrying the untracked file.
    expect(git(repo, ["cat-file", "-p", `${ref}:design.md`]).stdout).toBe("# design");
    // The branch never moved.
    expect(git(repo, ["rev-parse", "main"]).stdout).not.toBe(cp!.sha);
  });

  it("records nothing for a clean worktree", () => {
    const repo = makeRepo();
    expect(createCheckpoint(repo, checkpointRef("job1", "design", 1))).toBeNull();
  });

  it("survives deletion of the branch it came from", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);
    createCheckpoint(repo, ref);

    git(repo, ["checkout", "-q", "--detach"]);
    git(repo, ["branch", "-D", "main"]);
    expect(git(repo, ["cat-file", "-p", `${ref}:design.md`]).stdout).toBe("# design");
  });
});

describe("isCapturedAt / capturingRef", () => {
  it("recognises a worktree that matches its checkpoint", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);
    createCheckpoint(repo, ref);
    expect(isCapturedAt(repo, ref)).toBe(true);
    expect(capturingRef(repo, "job1")).toBe(ref);
  });

  it("rejects a checkpoint that has gone stale", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);
    createCheckpoint(repo, ref);

    // Work done after the checkpoint is not covered by it.
    writeFileSync(join(repo, "design.md"), "# design, revised\n");
    expect(isCapturedAt(repo, ref)).toBe(false);
    expect(capturingRef(repo, "job1")).toBeNull();
  });

  it("returns false for a ref that does not exist", () => {
    const repo = makeRepo();
    expect(isCapturedAt(repo, checkpointRef("nope", "design", 9))).toBe(false);
  });
});

describe("cleanup classification with checkpoints (D46 mechanism C)", () => {
  const finishedJob = (worktree: string): Job =>
    ({
      id: "job1",
      status: "done",
      worktree,
      branch: "main",
      cwd: worktree,
    }) as Job;

  it("still refuses a dirty worktree with no checkpoint", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const a = assessWorktree({ path: repo, branch: "main" }, finishedJob(repo), repo, "main", null);
    expect(a.classification).toBe("NEEDS_REVIEW");
    expect(a.reason).toContain("uncommitted");
  });

  it("allows removal once the dirty state is parked", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);
    createCheckpoint(repo, ref);

    const a = assessWorktree({ path: repo, branch: "main" }, finishedJob(repo), repo, "main", ref);
    expect(a.classification).toBe("SAFE_TO_REMOVE");
    expect(a.reason).toContain(ref);
    expect(a.dirty).toBe(true);
  });

  it("refuses again when work has moved on since the checkpoint", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "design.md"), "# design\n");
    const ref = checkpointRef("job1", "design", 1);
    createCheckpoint(repo, ref);
    writeFileSync(join(repo, "design.md"), "# revised\n");

    const a = assessWorktree({ path: repo, branch: "main" }, finishedJob(repo), repo, "main", ref);
    expect(a.classification).toBe("NEEDS_REVIEW");
  });
});

describe("the daemon checkpoints each turn (D46 mechanism B)", () => {
  async function setup() {
    const repo = makeRepo();
    const base = join(repo, "..");
    setEnv("AGVSR_WORKTREES", join(base, "worktrees"));
    setEnv("AGVSR_SEED_PATHS", "off");

    let onTurn: ((cwd: string) => void) | null = null;
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const sock = join(base, "d.sock");
    openDaemon = await startDaemon({
      endpoint: sock,
      storeFile: join(base, "d.sqlite"),
      team: TEAM,
      interruptRunningJobsOnStart: false,
      turnRunner: async (d) => {
        onTurn?.(d.effectiveCwd);
        return {
          events: [{ kind: "result", ok: true, text: d.role }],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });
    const c = await Client.connect(sock);
    return { repo, c, setOnTurn: (fn: (cwd: string) => void) => (onTurn = fn) };
  }

  /** Cheap poll: listing refs does not rebuild a tree the way capturingRef does. */
  function checkpointRefs(repo: string, jobId: string): string[] {
    const listed = git(repo, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/agvsr/checkpoints/${jobId}`,
    ]);
    return listed.stdout ? listed.stdout.split("\n").filter(Boolean) : [];
  }

  async function waitFor(check: () => boolean, tries = 500): Promise<void> {
    for (let i = 0; i < tries; i++) {
      if (check()) return;
      await Bun.sleep(10);
    }
  }

  it("parks work a turn leaves uncommitted, and reclaim reports where", async () => {
    const { repo, c, setOnTurn } = await setup();
    // The supervisor's turn writes a file and does not commit it — the exact
    // shape of the design document that sat untracked for a whole recorded job.
    setOnTurn((cwd) => writeFileSync(join(cwd, "design.md"), "# design\n"));

    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    expect(created.ok).toBe(true);
    const job = created.ok ? created.result.job : null;
    const worktree = job!.worktree!;

    await waitFor(() => checkpointRefs(repo, job!.id).length > 0);
    const ref = capturingRef(worktree, job!.id);
    expect(ref).not.toBeNull();

    // A failing job, not a completing one: `job.complete` is held by the
    // commit gate precisely because the worktree is dirty, so the worktrees
    // that actually piled up (53 of 55 in one cleanup) came from failures.
    await c.request("job.fail", { job_id: job!.id, reason: "gave up" });
    await waitFor(() => !existsSync(worktree));

    // The worktree is gone and the work is not.
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, ["cat-file", "-p", `${ref}:design.md`]).stdout).toBe("# design");

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job!.id });
    const note = (logs.ok ? logs.result.messages : []).find((m) => m.body.includes("Reclaimed"));
    expect(note?.body).toContain(ref!);
    c.close();
  }, 30_000);

  it("does not let a checkpoint stand in for committing the work", async () => {
    const { repo, c, setOnTurn } = await setup();
    setOnTurn((cwd) => writeFileSync(join(cwd, "design.md"), "# design\n"));

    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    const job = created.ok ? created.result.job : null;
    await waitFor(() => checkpointRefs(repo, job!.id).length > 0);

    // Checkpoints exist to make work recoverable, not to make it delivered.
    // The commit gate is unchanged: a dirty worktree still cannot complete.
    const done = await c.request("job.complete", { job_id: job!.id, result: "done" });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe("commit_required");
    c.close();
  }, 30_000);

  it("stands down when AGVSR_CHECKPOINTS is disabled", async () => {
    setEnv("AGVSR_CHECKPOINTS", "0");
    const { repo, c, setOnTurn } = await setup();
    setOnTurn((cwd) => writeFileSync(join(cwd, "design.md"), "# design\n"));

    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    const job = created.ok ? created.result.job : null;
    const worktree = job!.worktree!;
    await waitFor(() => existsSync(join(worktree, "design.md")));
    await Bun.sleep(300);

    expect(checkpointRefs(repo, job!.id)).toEqual([]);
    c.close();
  }, 30_000);
});
