/**
 * Commit check on handoff artifacts (D46).
 *
 * A role finishes a piece of work and hands it to the supervisor, citing the
 * files it produced in `refs`. Nothing until now required those files to be
 * committed. In one recorded job a 587-line design document sat untracked in
 * the worktree for the whole run: the QA plan from a different role was
 * committed, the design was not, and only a human noticing saved it.
 *
 * Uncommitted work is invisible to every mechanism that matters. It cannot be
 * merged, `agvsr cleanup` refuses to reclaim the worktree holding it (which is
 * why they accumulate), and the commit gate at job completion never runs for a
 * job that fails. Checking at the handoff — the moment the artifact is claimed
 * as finished — is the earliest point where the role is still there to fix it.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type RefProblem = "uncommitted" | "untracked";

export interface UncommittedRef {
  path: string;
  problem: RefProblem;
  /** `git status --porcelain` codes, when the path is dirty rather than absent. */
  detail: string;
}

export function refsGateEnabled(): boolean {
  const raw = process.env.AGVSR_REFS_GATE;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trimEnd() };
}

/**
 * A ref as a path relative to `worktree`, or null when it points outside it.
 *
 * Refs are authored by agents, so they arrive as whatever the agent had in
 * hand: absolute paths, worktree-relative paths, occasionally something from
 * another tree entirely. Only paths inside the worktree can be checked, and a
 * path outside it is not this gate's business to judge.
 */
function toWorktreeRelative(worktree: string, ref: string): string | null {
  const abs = isAbsolute(ref) ? resolve(ref) : resolve(worktree, ref);
  const rel = relative(resolve(worktree), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Refs that are not committed on the branch. Works for files and directories
 * alike: `git status` reports anything dirty underneath a directory, and
 * `git ls-files` reports whether anything at the path is tracked at all.
 */
export function uncommittedRefs(worktree: string, refs: string[]): UncommittedRef[] {
  const problems: UncommittedRef[] = [];
  for (const ref of refs) {
    const rel = toWorktreeRelative(worktree, ref);
    if (rel === null) continue;

    const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all", "--", rel]);
    // A failing `git status` means the worktree is not usable as a repo; that is
    // not something the sending role can fix by committing, so it is not raised
    // here. The commit gate at completion still covers it.
    if (!status.ok) continue;

    if (status.stdout.length > 0) {
      const untracked = status.stdout
        .split("\n")
        .every((line) => line.startsWith("??") || line.startsWith("!!"));
      problems.push({
        path: ref,
        problem: untracked ? "untracked" : "uncommitted",
        detail: status.stdout,
      });
      continue;
    }

    // Clean, but that is also what a path holding nothing looks like.
    const tracked = git(worktree, ["ls-files", "--", rel]);
    if (tracked.ok && tracked.stdout.length === 0) {
      problems.push({ path: ref, problem: "untracked", detail: "no such tracked path" });
    }
  }
  return problems;
}

export function refsGateMessage(
  role: string,
  branch: string | null,
  problems: UncommittedRef[],
): string {
  const rows = problems
    .map((p) => {
      const head = p.detail.split("\n")[0] ?? "";
      const note = p.problem === "untracked" ? "untracked" : head.trim();
      return `  ${p.path}  (${note})`;
    })
    .join("\n");
  return [
    `Referenced artifacts are not committed on the job branch.`,
    `A worktree can be reclaimed at any time; only committed work survives.`,
    ``,
    rows,
    ``,
    `Commit them on ${branch ?? "the job branch"} as ${role}, then hand off again.`,
  ].join("\n");
}
