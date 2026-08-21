/**
 * Turn-end checkpoints for job worktrees (D46 mechanisms B and C).
 *
 * The handoff gate (`refs-gate.ts`) catches artifacts a role *claims* as
 * finished. It cannot catch the rest: work in progress when a turn ends, a job
 * that fails before any handoff, a file an agent creates and a later turn
 * deletes. All of that lives only in the worktree, which is exactly the thing
 * `agvsr cleanup` and automatic reclamation want to remove.
 *
 * So the daemon takes its own snapshot after every turn. Nothing is asked of
 * the agent and no tokens are spent: git builds a commit from the worktree's
 * current state and it is parked under `refs/agvsr/checkpoints/...`, off any
 * branch. Two consequences worth the machinery:
 *
 *   - Uncommitted work stops being destructible. Removing the worktree, or
 *     deleting the job branch, no longer discards anything.
 *   - A dirty worktree becomes reclaimable (mechanism C). Worktrees piled up
 *     — 53 of 55 in one recorded cleanup — because dirty meant unrecoverable,
 *     so cleanup correctly refused to touch them. Once the dirty state is in a
 *     ref, removing the directory costs nothing.
 *
 * `git stash create` is the obvious tool here and the wrong one: it captures
 * tracked modifications only. The artifact this exists to protect — a design
 * document nobody had run `git add` on — is precisely what it drops. Building
 * the tree through a scratch index captures untracked files too, while leaving
 * the worktree's real index and working tree untouched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface Checkpoint {
  /** The parked commit. */
  sha: string;
  /** Its tree — the identity of the worktree state, used to compare later. */
  tree: string;
  ref: string;
}

export function checkpointsEnabled(): boolean {
  const raw = process.env.AGVSR_CHECKPOINTS;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

/** Ref namespace for one role's checkpoints. Shared across worktrees, so it
 * outlives the worktree it describes. */
export function checkpointRef(jobId: string, role: string, turn: number): string {
  return `refs/agvsr/checkpoints/${jobId}/${role}/${turn}`;
}

export function checkpointRefPrefix(jobId: string): string {
  return `refs/agvsr/checkpoints/${jobId}`;
}

/**
 * Tree object for everything the worktree currently holds — tracked changes and
 * untracked files alike, minus what gitignore excludes. Null when the worktree
 * is not a usable checkout.
 *
 * The scratch index is what keeps this side-effect free: `git add -A` against
 * `GIT_INDEX_FILE` stages into a throwaway file, so the agent's own index (it
 * may have staged something deliberately) is never disturbed.
 */
export function snapshotTree(worktree: string): string | null {
  if (!git(worktree, ["rev-parse", "--verify", "HEAD"]).ok) return null;
  const scratch = mkdtempSync(join(tmpdir(), "agvsr-cp-"));
  const indexFile = join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    if (!git(worktree, ["read-tree", "HEAD"], env).ok) return null;
    // Deliberately not `--force`: ignored paths (node_modules, seeded caches)
    // must stay out, or every checkpoint would carry a dependency tree.
    if (!git(worktree, ["add", "-A"], env).ok) return null;
    const tree = git(worktree, ["write-tree"], env);
    return tree.ok && tree.stdout ? tree.stdout : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Park the worktree's current state at `ref`. Returns null when there is
 * nothing to record (the state already matches HEAD) or git refuses.
 *
 * Best effort by design: a checkpoint that cannot be taken must not fail the
 * turn that produced the work.
 */
export function createCheckpoint(worktree: string, ref: string): Checkpoint | null {
  const tree = snapshotTree(worktree);
  if (!tree) return null;

  const head = git(worktree, ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  // A tree identical to HEAD's means the worktree is clean; committing it would
  // park an empty change and make every clean turn look like it produced work.
  const headTree = git(worktree, ["rev-parse", "HEAD^{tree}"]);
  if (headTree.ok && headTree.stdout === tree) return null;

  const commit = git(worktree, [
    "commit-tree",
    tree,
    "-p",
    head.stdout,
    "-m",
    "agvsr checkpoint: uncommitted worktree state",
  ]);
  if (!commit.ok || !commit.stdout) return null;

  if (!git(worktree, ["update-ref", ref, commit.stdout]).ok) return null;
  return { sha: commit.stdout, tree, ref };
}

/** The tree recorded at `ref`, or null when the ref does not resolve. */
export function treeAt(worktree: string, ref: string): string | null {
  const r = git(worktree, ["rev-parse", "--verify", `${ref}^{tree}`]);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * Whether every byte currently in the worktree is already parked at `ref`.
 * This is what lets cleanup remove a dirty worktree without losing anything.
 */
export function isCapturedAt(worktree: string, ref: string): boolean {
  const parked = treeAt(worktree, ref);
  if (!parked) return false;
  return snapshotTree(worktree) === parked;
}

/**
 * The job's checkpoint ref that parks this worktree exactly as it stands, or
 * null if none does.
 *
 * For callers without the daemon's store — `agvsr cleanup` reaches the daemon
 * over IPC and never sees the checkpoint table — this resolves the same answer
 * out of git alone: snapshot once, then compare against every parked tree.
 */
export function capturingRef(worktree: string, jobId: string): string | null {
  const tree = snapshotTree(worktree);
  if (!tree) return null;
  const listed = git(worktree, [
    "for-each-ref",
    "--format=%(refname) %(tree)",
    checkpointRefPrefix(jobId),
  ]);
  if (!listed.ok || !listed.stdout) return null;
  for (const line of listed.stdout.split("\n")) {
    const [ref, parked] = line.split(" ");
    if (ref && parked === tree) return ref;
  }
  return null;
}

/** Drop every checkpoint ref belonging to a job. */
export function dropCheckpoints(repoRoot: string, jobId: string): number {
  const prefix = checkpointRefPrefix(jobId);
  const listed = git(repoRoot, ["for-each-ref", "--format=%(refname)", prefix]);
  if (!listed.ok || !listed.stdout) return 0;
  let dropped = 0;
  for (const ref of listed.stdout.split("\n").filter(Boolean)) {
    if (git(repoRoot, ["update-ref", "-d", ref]).ok) dropped++;
  }
  return dropped;
}
