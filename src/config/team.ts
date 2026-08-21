/**
 * team.yaml loader + validation (D9, D16). Declarative roles: each binds a role
 * name to an adapter (CLI), a model string, and optional charter customization.
 * v1 is one instance per role, static (D9).
 *
 * Heuristic model warnings live in the adapter layer; here we validate
 * structure only so future model IDs keep working.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type TeamFormat = "yaml" | "toml";

export const ADAPTERS = ["claude-code", "codex", "agy"] as const;
export type Adapter = (typeof ADAPTERS)[number];

const RoleSchema = z.object({
  adapter: z.enum(ADAPTERS),
  model: z.string().min(1),
  /** Replace the bundled default charter wholesale (D25). */
  charter: z.string().optional(),
  /** Append to the bundled default charter (D25, most common). */
  charter_append: z.string().optional(),
  /**
   * Which bundled `charters/defaults/<name>.md` to use, independent of this
   * role's own key in `roles:`. Auto-set to "implementation" for entries
   * expanded from an `implementation:` array (D27); settable explicitly for
   * a custom-named role that wants to borrow a bundled charter.
   */
  charter_role: z.string().optional(),
  /** Absolute turn time limit in ms (overrides env/default). */
  hard_timeout_ms: z.number().int().positive().optional(),
  /** No-progress turn time limit in ms (overrides env/default). */
  idle_timeout_ms: z.number().int().positive().optional(),
  /**
   * How long this role must let a delegate start before it may escalate the
   * delegate's silence to the human (D44). Only meaningful on the supervisor.
   */
  min_delegation_wait_ms: z.number().int().nonnegative().optional(),
  /**
   * Opt-in network access inside the adapter's sandbox (currently only
   * codex's `sandbox_workspace_write.network_access` respects this; other
   * adapters ignore it). Default false keeps the existing network-denied
   * posture; set true for roles that must reach services on the host
   * (e.g. a QA role verifying against a local database).
   */
  network_access: z.boolean().optional(),
  /**
   * Extra environment variables for this role's agent process. Merged over the
   * team-level `env`, and both are overridden by agvsr's own reserved variables
   * (AGVSR_*, HERDR_*, PATH) so a config mistake cannot unwire the MCP shim.
   */
  env: z.record(z.string(), z.string()).optional(),
});

/**
 * What a job should do with one git-ignored environment file (D43).
 *
 * A key list is the safe form of `env`: a whole `.env` can carry variables
 * that change behaviour unrelated to the job, so naming the ones that matter
 * keeps the blast radius to what was intended.
 */
const EnvFileDispositionSchema = z.union([
  z.enum(["env", "copy", "ignore"]),
  z.array(z.string().min(1)).min(1),
]);

export type EnvFileDisposition = z.infer<typeof EnvFileDispositionSchema>;

const WorktreeSchema = z
  .object({
    /**
     * Disposition per git-ignored environment file, keyed by repo-relative
     * path. `job.create` refuses to start while any such file in the checkout
     * is undeclared — see src/git/env-parity.ts for why the check lives
     * outside the worktree.
     */
    env_files: z.record(z.string(), EnvFileDispositionSchema).optional(),
  })
  .optional();

/**
 * Independent verification the daemon runs itself before a job may complete
 * (D43 mechanism B). Opt-in: without this block nothing extra runs.
 */
const VerifySchema = z
  .object({
    /** Shell command, run in the job worktree and (for a baseline) the checkout. */
    command: z.string().min(1),
    /**
     * Regex whose first group captures how many tests ran. Omit to try the
     * built-in patterns for bun test, vitest, and jest.
     */
    count_pattern: z.string().optional(),
    /**
     * `source` (default) measures the checkout and caches per commit; `fixed:<n>`
     * states the expected count outright; `off` checks only the exit code.
     */
    baseline: z.union([z.enum(["source", "off"]), z.string().regex(/^fixed:\d+$/)]).optional(),
    /** How far below the baseline is tolerated (default 0). */
    tolerance: z.number().int().nonnegative().optional(),
    /** Per-run limit in ms (default 900000). */
    timeout_ms: z.number().int().positive().optional(),
  })
  .optional();

export type VerifyConfig = NonNullable<z.infer<typeof VerifySchema>>;

const HooksSchema = z
  .object({
    /** Shell command to run when a job completes successfully (D26). */
    on_job_done: z.string().optional(),
    /** Shell command to run when a job fails for any reason (D26). */
    on_job_failed: z.string().optional(),
    /** Shell command to run when supervisor sends a message to the user (D22c / D26). */
    on_supervisor_message: z.string().optional(),
    /** Shell command to run when the idle watchdog detects a stalled running job. */
    on_job_stalled: z.string().optional(),
  })
  .optional();

export type RoleConfig = z.infer<typeof RoleSchema>;

/** Public shape: always a flat map, even though `implementation:` may be
 * authored as an array in team.yaml (expanded by `parseTeam` before this
 * type is ever handed to a caller). */
export interface TeamConfig {
  roles: Record<string, RoleConfig>;
  hooks?: z.infer<typeof HooksSchema>;
  /** Environment shared by every role (see RawTeamSchema.env). */
  env?: Record<string, string>;
  /** Worktree provisioning policy, including env-file parity (D43). */
  worktree?: z.infer<typeof WorktreeSchema>;
  /** Independent verification run by the daemon before completion (D43). */
  verify?: VerifyConfig;
}

/** Raw shape as authored: `implementation:` may be a single role or an
 * array of roles (D27 — multiple concurrent, worktree-isolated instances). */
const RawTeamSchema = z.object({
  roles: z.record(z.string(), z.union([RoleSchema, z.array(RoleSchema).min(1)])),
  hooks: HooksSchema,
  /**
   * Environment shared by every role's agent process. This is where job-invariant
   * facts about the host belong — a test database URL, a registry token — so each
   * job does not have to rediscover them and relay them through the human.
   */
  env: z.record(z.string(), z.string()).optional(),
  worktree: WorktreeSchema,
  verify: VerifySchema,
});

export const SUPERVISOR = "supervisor";

/** The only role key allowed to be array-valued in team.yaml (D27, v1). */
const ARRAYABLE_ROLE = "implementation";

export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamConfigError";
  }
}

/**
 * Expand any array-valued role entries into flat, individually-addressable
 * keys (`implementation-1`, `implementation-2`, ...). Only `implementation`
 * may be array-valued (v1 restriction — other roles have no worktree
 * isolation or singular-role assumptions elsewhere that make concurrent
 * instances safe yet).
 */
function expandRoles(raw: Record<string, RoleConfig | RoleConfig[]>): Record<string, RoleConfig> {
  const expanded: Record<string, RoleConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      expanded[key] = value;
      continue;
    }
    if (key !== ARRAYABLE_ROLE) {
      throw new TeamConfigError(
        `team.yaml: "${key}" may not be array-valued (only "${ARRAYABLE_ROLE}" supports multiple, worktree-isolated instances).`,
      );
    }
    value.forEach((cfg, i) => {
      const name = `${key}-${i + 1}`;
      expanded[name] = { charter_role: key, ...cfg };
    });
  }
  return expanded;
}

export function parseTeam(text: string, format: TeamFormat = "yaml"): TeamConfig {
  const label = format === "toml" ? "team.toml" : "team.yaml";

  let raw: unknown;
  try {
    raw = format === "toml" ? Bun.TOML.parse(text) : parseYaml(text);
  } catch (err) {
    throw new TeamConfigError(
      `${label} is not valid ${format === "toml" ? "TOML" : "YAML"}: ${(err as Error).message}`,
    );
  }

  const parsed = RawTeamSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new TeamConfigError(`${label} is invalid:\n${issues}`);
  }

  const team: TeamConfig = {
    roles: expandRoles(parsed.data.roles),
    hooks: parsed.data.hooks,
    env: parsed.data.env,
    worktree: parsed.data.worktree,
    verify: parsed.data.verify,
  };
  if (Object.keys(team.roles).length === 0) {
    throw new TeamConfigError(`${label} defines no roles.`);
  }
  if (!team.roles[SUPERVISOR]) {
    throw new TeamConfigError(
      `${label} must define a "${SUPERVISOR}" role (the star-topology hub, D10).`,
    );
  }
  return team;
}

/** `.toml` is TOML; everything else (`.yaml`, `.yml`, no extension, or any
 * custom path passed via `--team`/`$AGVSR_TEAM`) is treated as YAML, the
 * long-standing default. */
export function formatFromPath(path: string): TeamFormat {
  return path.endsWith(".toml") ? "toml" : "yaml";
}

/** Finds the team config file in `dir`, preferring `team.yaml` over
 * `team.toml` when both exist. Returns null if neither is present. */
export function findTeamFile(dir: string): string | null {
  const yamlPath = join(dir, "team.yaml");
  if (existsSync(yamlPath)) return yamlPath;
  const tomlPath = join(dir, "team.toml");
  if (existsSync(tomlPath)) return tomlPath;
  return null;
}

/**
 * Resolve the team file path: explicit arg ?? $AGVSR_TEAM ?? <cwd>/team.yaml
 * or team.toml (yaml preferred when both exist). Matches the daemon's team
 * file resolution (D9).
 */
export function resolveTeamFile(explicit?: string): string {
  const candidate = explicit ?? process.env.AGVSR_TEAM;
  if (candidate) return candidate;
  return findTeamFile(process.cwd()) ?? join(process.cwd(), "team.yaml");
}

export function loadTeam(path: string): TeamConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new TeamConfigError(`cannot read team config at ${path}: ${(err as Error).message}`);
  }
  return parseTeam(text, formatFromPath(path));
}

/**
 * Allowed `agvsr_send` targets for a role under the star topology (D10):
 * the supervisor may reach every worker plus the human (`user`, CH4);
 * a worker may reach only the supervisor.
 */
export function allowedTargets(team: TeamConfig, role: string): string[] {
  if (role === SUPERVISOR) {
    return [...Object.keys(team.roles).filter((r) => r !== SUPERVISOR), "user"];
  }
  return [SUPERVISOR];
}
