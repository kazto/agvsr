import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VALID_SKILL_TARGETS = ["claude", "gemini", "codex"] as const;
export type SkillTarget = (typeof VALID_SKILL_TARGETS)[number];
export const DEFAULT_SKILL_TARGETS = ["claude"] as const;

export type InstallScope = "global" | "project";

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

const BUNDLED_SKILL_SOURCE_PATH = fileURLToPath(
  new URL("../../skills/agvsr/SKILL.md", import.meta.url),
);

// Codex has no user-definable custom-command mechanism (its own `/skills` and
// `/skill-installer` slash commands are built-in CLI directives for managing
// skills, not something a package can install) — only claude and gemini get
// a bundled command file. Codex users invoke the installed skill explicitly
// with `$agvsr` or browse via `/skills` instead of expecting a `/agvsr` command.
const BUNDLED_COMMAND_SOURCE_PATHS: Partial<Record<SkillTarget, string>> = {
  claude: fileURLToPath(new URL("../../commands/agvsr.md", import.meta.url)),
  gemini: fileURLToPath(new URL("../../commands/agvsr.toml", import.meta.url)),
};

export function readBundledSkillSource(): string {
  return readFileSync(BUNDLED_SKILL_SOURCE_PATH, "utf8");
}

/** Reads the bundled `/agvsr` command source for a target, or null if that
 * target has no custom-command mechanism (codex). */
export function readBundledCommandSource(target: SkillTarget): string | null {
  const path = BUNDLED_COMMAND_SOURCE_PATHS[target];
  return path === undefined ? null : readFileSync(path, "utf8");
}

function requireProjectDir(scope: InstallScope, projectDir: string | undefined): string {
  if (scope === "project" && projectDir === undefined) {
    throw new SkillInstallError("project scope requires a projectDir");
  }
  return projectDir as string;
}

/** Resolves where the bundled skill installs for a target. `codex` always
 * installs globally under `$CODEX_HOME`/`~/.codex`, ignoring `scope`. */
export function resolveSkillTargetPath(
  target: SkillTarget,
  scope: InstallScope,
  projectDir?: string,
): string {
  switch (target) {
    case "claude":
      return scope === "global"
        ? resolve(homedir(), ".claude/skills/agvsr/SKILL.md")
        : resolve(requireProjectDir(scope, projectDir), ".claude/skills/agvsr/SKILL.md");
    case "gemini":
      return scope === "global"
        ? resolve(homedir(), ".gemini/skills/agvsr/SKILL.md")
        : resolve(requireProjectDir(scope, projectDir), ".gemini/skills/agvsr/SKILL.md");
    case "codex": {
      const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      return resolve(codexHome, "skills/agvsr/SKILL.md");
    }
  }
}

/** Resolves where the bundled `/agvsr` command installs for a target, or
 * null if that target has no custom-command mechanism (codex). `codex`
 * has no command file, so `scope` doesn't apply to it. */
export function resolveCommandTargetPath(
  target: SkillTarget,
  scope: InstallScope,
  projectDir?: string,
): string | null {
  switch (target) {
    case "claude":
      return scope === "global"
        ? resolve(homedir(), ".claude/commands/agvsr.md")
        : resolve(requireProjectDir(scope, projectDir), ".claude/commands/agvsr.md");
    case "gemini":
      return scope === "global"
        ? resolve(homedir(), ".gemini/commands/agvsr.toml")
        : resolve(requireProjectDir(scope, projectDir), ".gemini/commands/agvsr.toml");
    case "codex":
      return null;
  }
}

export function parseSkillTargets(rawTargets: readonly string[] | undefined): SkillTarget[] {
  if (rawTargets === undefined) return [...DEFAULT_SKILL_TARGETS];

  const seen = new Set<SkillTarget>();
  const targets: SkillTarget[] = [];
  for (const raw of rawTargets) {
    for (const part of raw.split(",")) {
      const target = part.trim();
      if (!target) {
        throw new SkillInstallError("empty --target entry");
      }
      if (!(VALID_SKILL_TARGETS as readonly string[]).includes(target)) {
        throw new SkillInstallError(
          `unknown --target "${target}". Valid targets: ${VALID_SKILL_TARGETS.join(", ")}`,
        );
      }
      const typed = target as SkillTarget;
      if (seen.has(typed)) continue;
      seen.add(typed);
      targets.push(typed);
    }
  }

  if (targets.length === 0) {
    throw new SkillInstallError("empty --target list");
  }

  return targets;
}
