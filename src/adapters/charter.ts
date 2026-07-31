/**
 * Charter composition (D25). Three layers:
 *   1. scaffold.md   — agvsr protocol, always injected, placeholders filled here.
 *   2. defaults/<role>.md — bundled role charter (or a user override/append).
 *   3. user customization via team.yaml (`charter` replace / `charter_append`).
 * The result is one system-prompt string the adapter injects per CLI.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { allowedTargets, SUPERVISOR, type RoleConfig, type TeamConfig } from "../config/team.ts";

/** Per-job/role values substituted into the scaffold. */
export interface CharterContext {
  role: string;
  jobId: string;
  cwd: string;
  branch?: string | null;
  allowedTargets: string[];
  /** True when this role has its own dedicated worktree/branch (D27 —
   * array-expanded `implementation-N` instances), false for roles sharing
   * the job's own worktree. */
  isolatedWorktree?: boolean;
}

function workspaceNote(ctx: Pick<CharterContext, "cwd" | "branch" | "isolatedWorktree">): string {
  if (ctx.isolatedWorktree) {
    return (
      `You have your own dedicated working tree at \`${ctx.cwd}\`, isolated from the job's ` +
      `shared workspace and any sibling instances. Commit your work on your own branch ` +
      `(\`${ctx.branch ?? "(not set)"}\`) — the supervisor merges it into the job branch once ` +
      `you report completion.`
    );
  }
  return (
    `All roles operate on the same working tree at \`${ctx.cwd}\`. You do not have exclusive ` +
    `ownership of it.`
  );
}

export interface CharterDirs {
  /** Directory holding scaffold.md and defaults/. Defaults to bundled `charters/`. */
  chartersDir?: string;
  /** Base for resolving relative `charter`/`charter_append` paths (team.yaml dir). */
  baseDir?: string;
}

const BUNDLED = join(import.meta.dir, "..", "..", "charters");

const COMPLETION_TOOLS = `- \`agvsr_complete(job_id, result)\` — Declare the job done and deliver the result to
  the human. Only you (the supervisor) may call this.
- \`agvsr_fail(job_id, reason)\` — Declare the job impossible, with a reason. Only you
  may call this.`;

/** Strip HTML comments — they are maintainer notes, not for the LLM. */
function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->\n?/g, "");
}

/** Substitute the scaffold placeholders. Pure. */
export function fillScaffold(scaffold: string, ctx: CharterContext): string {
  const isSupervisor = ctx.role === SUPERVISOR;
  const subs: Record<string, string> = {
    role: ctx.role,
    job_id: ctx.jobId,
    cwd: ctx.cwd,
    branch: ctx.branch ?? "(not set)",
    allowed_targets: ctx.allowedTargets.join(", "),
    completion_tools: isSupervisor ? COMPLETION_TOOLS : "",
    workspace_note: workspaceNote(ctx),
  };
  return scaffold.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in subs ? subs[key]! : whole,
  );
}

function readRoleCharter(role: string, cfg: RoleConfig, dirs: CharterDirs): string {
  const chartersDir = dirs.chartersDir ?? BUNDLED;
  const base = dirs.baseDir ?? process.cwd();
  const resolvePath = (p: string) => (isAbsolute(p) ? p : resolve(base, p));

  if (cfg.charter) {
    return readFileSync(resolvePath(cfg.charter), "utf8"); // wholesale replace
  }
  const def = readFileSync(join(chartersDir, "defaults", `${cfg.charter_role ?? role}.md`), "utf8");
  if (cfg.charter_append) {
    return `${def}\n\n${readFileSync(resolvePath(cfg.charter_append), "utf8")}`;
  }
  return def;
}

/**
 * Build the full system prompt for a role on a job: filled scaffold + role charter.
 */
export function composeCharter(
  team: TeamConfig,
  role: string,
  ctx: Omit<CharterContext, "role" | "allowedTargets">,
  dirs: CharterDirs = {},
): string {
  const cfg = team.roles[role];
  if (!cfg) throw new Error(`composeCharter: no role "${role}" in team`);

  const chartersDir = dirs.chartersDir ?? BUNDLED;
  const scaffold = stripHtmlComments(readFileSync(join(chartersDir, "scaffold.md"), "utf8"));
  const roleCharter = readRoleCharter(role, cfg, dirs);
  // Fill placeholders across the combined text in one pass, not just the
  // scaffold — the bundled implementation.md itself contains `{{cwd}}`,
  // which must resolve too, not leak into the agent's prompt verbatim.
  const combined = `${scaffold.trimEnd()}\n\n${roleCharter.trimEnd()}\n`;
  return fillScaffold(combined, {
    role,
    jobId: ctx.jobId,
    cwd: ctx.cwd,
    branch: ctx.branch,
    allowedTargets: allowedTargets(team, role),
    isolatedWorktree: ctx.isolatedWorktree,
  });
}
