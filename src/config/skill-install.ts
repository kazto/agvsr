import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VALID_SKILL_TARGETS = ["claude", "gemini", "codex"] as const;
export type SkillTarget = (typeof VALID_SKILL_TARGETS)[number];
export const DEFAULT_SKILL_TARGETS = ["claude"] as const;

// self-improve has no /agvsr-style bootstrap step, so it relies entirely on
// the skill's own frontmatter description for discovery — no bundled slash
// command. Keep new skills in this list minimal; each one adds a whole
// row to the skill x target install matrix.
export const VALID_SKILL_NAMES = ["agvsr", "self-improve"] as const;
export type SkillName = (typeof VALID_SKILL_NAMES)[number];
// `agvsr skill install` with no `--skill` must keep installing only `agvsr`
// — this is the sole place that guarantees that backward-compat default.
export const DEFAULT_SKILL_NAMES = ["agvsr"] as const;

export type InstallScope = "global" | "project";

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

const BUNDLED_SKILL_SOURCE_PATHS: Record<SkillName, string> = {
  agvsr: fileURLToPath(new URL("../../skills/agvsr/SKILL.md", import.meta.url)),
  "self-improve": fileURLToPath(new URL("../../skills/self-improve/SKILL.md", import.meta.url)),
};

// Codex has no user-definable custom-command mechanism (its own `/skills` and
// `/skill-installer` slash commands are built-in CLI directives for managing
// skills, not something a package can install) — only claude and gemini get
// a bundled command file, and only for skills that actually have one.
const BUNDLED_COMMAND_SOURCE_PATHS: Partial<
  Record<SkillName, Partial<Record<SkillTarget, string>>>
> = {
  agvsr: {
    claude: fileURLToPath(new URL("../../commands/agvsr.md", import.meta.url)),
    gemini: fileURLToPath(new URL("../../commands/agvsr.toml", import.meta.url)),
  },
};

export function readBundledSkillSource(skill: SkillName): string {
  return readFileSync(BUNDLED_SKILL_SOURCE_PATHS[skill], "utf8");
}

/** Reads the bundled command source for a skill+target, or null if that
 * skill has no command for that target (e.g. codex has no custom-command
 * mechanism at all; self-improve has no command for any target). */
export function readBundledCommandSource(skill: SkillName, target: SkillTarget): string | null {
  const path = BUNDLED_COMMAND_SOURCE_PATHS[skill]?.[target];
  return path === undefined ? null : readFileSync(path, "utf8");
}

function requireProjectDir(scope: InstallScope, projectDir: string | undefined): string {
  if (scope === "project" && projectDir === undefined) {
    throw new SkillInstallError("project scope requires a projectDir");
  }
  return projectDir as string;
}

/** Resolves where a bundled skill installs for a target. `codex` always
 * installs globally under `$CODEX_HOME`/`~/.codex`, ignoring `scope`. */
export function resolveSkillTargetPath(
  skill: SkillName,
  target: SkillTarget,
  scope: InstallScope,
  projectDir?: string,
): string {
  switch (target) {
    case "claude":
      return scope === "global"
        ? resolve(homedir(), ".claude/skills", skill, "SKILL.md")
        : resolve(requireProjectDir(scope, projectDir), ".claude/skills", skill, "SKILL.md");
    case "gemini":
      return scope === "global"
        ? resolve(homedir(), ".gemini/skills", skill, "SKILL.md")
        : resolve(requireProjectDir(scope, projectDir), ".gemini/skills", skill, "SKILL.md");
    case "codex": {
      const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      return resolve(codexHome, "skills", skill, "SKILL.md");
    }
  }
}

/** Resolves where a bundled command installs for a skill+target, or null if
 * that skill has no command for that target (codex never has one; some
 * skills, like self-improve, have no command for any target). `codex` has
 * no command file, so `scope` doesn't apply to it. */
export function resolveCommandTargetPath(
  skill: SkillName,
  target: SkillTarget,
  scope: InstallScope,
  projectDir?: string,
): string | null {
  if (BUNDLED_COMMAND_SOURCE_PATHS[skill]?.[target] === undefined) return null;
  switch (target) {
    case "claude":
      return scope === "global"
        ? resolve(homedir(), `.claude/commands/${skill}.md`)
        : resolve(requireProjectDir(scope, projectDir), `.claude/commands/${skill}.md`);
    case "gemini":
      return scope === "global"
        ? resolve(homedir(), `.gemini/commands/${skill}.toml`)
        : resolve(requireProjectDir(scope, projectDir), `.gemini/commands/${skill}.toml`);
    case "codex":
      return null;
  }
}

function parseNames<T extends string>(
  raw: readonly string[] | undefined,
  valid: readonly T[],
  defaults: readonly T[],
  flag: string,
): T[] {
  if (raw === undefined) return [...defaults];

  const seen = new Set<T>();
  const names: T[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const name = part.trim();
      if (!name) {
        throw new SkillInstallError(`empty --${flag} entry`);
      }
      if (!(valid as readonly string[]).includes(name)) {
        throw new SkillInstallError(
          `unknown --${flag} "${name}". Valid ${flag}s: ${valid.join(", ")}`,
        );
      }
      const typed = name as T;
      if (seen.has(typed)) continue;
      seen.add(typed);
      names.push(typed);
    }
  }

  if (names.length === 0) {
    throw new SkillInstallError(`empty --${flag} list`);
  }

  return names;
}

export function parseSkillTargets(rawTargets: readonly string[] | undefined): SkillTarget[] {
  return parseNames(rawTargets, VALID_SKILL_TARGETS, DEFAULT_SKILL_TARGETS, "target");
}

export function parseSkillNames(rawNames: readonly string[] | undefined): SkillName[] {
  return parseNames(rawNames, VALID_SKILL_NAMES, DEFAULT_SKILL_NAMES, "skill");
}
