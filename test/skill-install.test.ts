import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SKILL_TARGETS,
  parseSkillTargets,
  readBundledCommandSource,
  resolveCommandTargetPath,
  resolveSkillTargetPath,
  SkillInstallError,
  VALID_SKILL_TARGETS,
} from "../src/config/skill-install.ts";

const oldCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
});

describe("skill target helpers", () => {
  it("defaults to Claude only", () => {
    expect(DEFAULT_SKILL_TARGETS).toEqual(["claude"]);
    expect(parseSkillTargets(undefined)).toEqual(["claude"]);
  });

  it("parses comma-separated and repeated targets with first-seen dedupe", () => {
    expect(parseSkillTargets(["claude,gemini", "gemini", "codex", "claude"])).toEqual([
      "claude",
      "gemini",
      "codex",
    ]);
  });

  it("rejects empty and unknown targets", () => {
    expect(() => parseSkillTargets([""])).toThrow("empty --target entry");
    expect(() => parseSkillTargets(["claude,,gemini"])).toThrow("empty --target entry");
    expect(() => parseSkillTargets(["banana"])).toThrow('unknown --target "banana"');
    expect(VALID_SKILL_TARGETS).toEqual(["claude", "gemini", "codex"]);
  });

  it("resolves global destination paths under the real home directory", () => {
    expect(resolveSkillTargetPath("claude", "global")).toBe(
      join(homedir(), ".claude", "skills", "agvsr", "SKILL.md"),
    );
    expect(resolveSkillTargetPath("gemini", "global")).toBe(
      join(homedir(), ".gemini", "skills", "agvsr", "SKILL.md"),
    );
  });

  it("resolves project-scoped destination paths under the given projectDir", () => {
    const projectDir = join("/tmp", "agvsr-skill-install-target");
    expect(resolveSkillTargetPath("claude", "project", projectDir)).toBe(
      join(projectDir, ".claude", "skills", "agvsr", "SKILL.md"),
    );
    expect(resolveSkillTargetPath("gemini", "project", projectDir)).toBe(
      join(projectDir, ".gemini", "skills", "agvsr", "SKILL.md"),
    );
  });

  it("throws when project scope is requested without a projectDir", () => {
    expect(() => resolveSkillTargetPath("claude", "project")).toThrow(SkillInstallError);
    expect(() => resolveCommandTargetPath("claude", "project")).toThrow(SkillInstallError);
  });

  it("codex always resolves via CODEX_HOME regardless of scope", () => {
    process.env.CODEX_HOME = "/tmp/agvsr-codex-home";
    const projectDir = join("/tmp", "agvsr-skill-install-target");
    expect(resolveSkillTargetPath("codex", "global")).toBe(
      join("/tmp/agvsr-codex-home", "skills", "agvsr", "SKILL.md"),
    );
    expect(resolveSkillTargetPath("codex", "project", projectDir)).toBe(
      join("/tmp/agvsr-codex-home", "skills", "agvsr", "SKILL.md"),
    );
  });

  it("codex falls back to the real home directory when CODEX_HOME is unset", () => {
    delete process.env.CODEX_HOME;
    expect(resolveSkillTargetPath("codex", "global")).toBe(
      join(homedir(), ".codex", "skills", "agvsr", "SKILL.md"),
    );
  });
});

describe("command target helpers", () => {
  it("resolves claude and gemini command destinations for both scopes, and null for codex", () => {
    const projectDir = join("/tmp", "agvsr-skill-install-target");
    expect(resolveCommandTargetPath("claude", "global")).toBe(
      join(homedir(), ".claude", "commands", "agvsr.md"),
    );
    expect(resolveCommandTargetPath("gemini", "global")).toBe(
      join(homedir(), ".gemini", "commands", "agvsr.toml"),
    );
    expect(resolveCommandTargetPath("claude", "project", projectDir)).toBe(
      join(projectDir, ".claude", "commands", "agvsr.md"),
    );
    expect(resolveCommandTargetPath("gemini", "project", projectDir)).toBe(
      join(projectDir, ".gemini", "commands", "agvsr.toml"),
    );
    // Codex has no user-definable custom-command mechanism.
    expect(resolveCommandTargetPath("codex", "global")).toBeNull();
  });

  it("reads the bundled command source for claude and gemini, and null for codex", () => {
    const root = join(import.meta.dir, "..");
    expect(readBundledCommandSource("claude")).toBe(
      readFileSync(join(root, "commands/agvsr.md"), "utf8"),
    );
    expect(readBundledCommandSource("gemini")).toBe(
      readFileSync(join(root, "commands/agvsr.toml"), "utf8"),
    );
    expect(readBundledCommandSource("codex")).toBeNull();
  });
});
