/**
 * team.yaml loader + validation (D9, D16). Declarative roles: each binds a role
 * name to an adapter (CLI), a model string, and optional charter customization.
 * v1 is one instance per role, static (D9).
 *
 * Model-string availability is validated against each adapter at startup in
 * Phase 2 (needs the adapters); here we validate structure only.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ADAPTERS = ["claude-code", "codex", "agy"] as const;
export type Adapter = (typeof ADAPTERS)[number];

const RoleSchema = z.object({
  adapter: z.enum(ADAPTERS),
  model: z.string().min(1),
  /** Replace the bundled default charter wholesale (D25). */
  charter: z.string().optional(),
  /** Append to the bundled default charter (D25, most common). */
  charter_append: z.string().optional(),
  instances: z.number().int().positive().default(1),
  /** Absolute turn time limit in ms (overrides env/default). */
  hard_timeout_ms: z.number().int().positive().optional(),
  /** No-progress turn time limit in ms (overrides env/default). */
  idle_timeout_ms: z.number().int().positive().optional(),
});

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

const TeamSchema = z.object({
  roles: z.record(z.string(), RoleSchema),
  hooks: HooksSchema,
});

export type RoleConfig = z.infer<typeof RoleSchema>;
export type TeamConfig = z.infer<typeof TeamSchema>;

export const SUPERVISOR = "supervisor";

export class TeamConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamConfigError";
  }
}

export function parseTeam(text: string): TeamConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new TeamConfigError(`team.yaml is not valid YAML: ${(err as Error).message}`);
  }

  const parsed = TeamSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new TeamConfigError(`team.yaml is invalid:\n${issues}`);
  }

  const team = parsed.data;
  if (Object.keys(team.roles).length === 0) {
    throw new TeamConfigError("team.yaml defines no roles.");
  }
  if (!team.roles[SUPERVISOR]) {
    throw new TeamConfigError(
      `team.yaml must define a "${SUPERVISOR}" role (the star-topology hub, D10).`,
    );
  }
  return team;
}

export function loadTeam(path: string): TeamConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new TeamConfigError(`cannot read team config at ${path}: ${(err as Error).message}`);
  }
  return parseTeam(text);
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
