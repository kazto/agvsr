import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "src/cli/agvsr.ts");
const BUNDLED_SKILL = join(ROOT, "skills/agvsr/SKILL.md");
const BUNDLED_SKILL_SELF_IMPROVE = join(ROOT, "skills/self-improve/SKILL.md");
const BUNDLED_COMMAND_CLAUDE = join(ROOT, "commands/agvsr.md");
const BUNDLED_COMMAND_GEMINI = join(ROOT, "commands/agvsr.toml");

function runSkillInstall(args: string[], opts: { env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(["bun", SCRIPT, "skill", "install", ...args], {
    cwd: ROOT,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function skillPath(baseDir: string, target: "claude" | "gemini", skill = "agvsr"): string {
  return join(baseDir, `.${target}`, "skills", skill, "SKILL.md");
}

function commandPath(baseDir: string, target: "claude" | "gemini", skill = "agvsr"): string {
  return target === "claude"
    ? join(baseDir, ".claude", "commands", `${skill}.md`)
    : join(baseDir, ".gemini", "commands", `${skill}.toml`);
}

describe("agvsr skill install CLI", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-skill-install-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("default run installs the Claude skill + command globally under $HOME", () => {
    const fakeHome = makeTmpDir();
    const { code, stdout, stderr } = runSkillInstall([], { env: { HOME: fakeHome } });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("installed ");

    const claudeSkill = skillPath(fakeHome, "claude");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(readFileSync(claudeSkill, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));

    const claudeCommand = commandPath(fakeHome, "claude");
    expect(existsSync(claudeCommand)).toBe(true);
    expect(readFileSync(claudeCommand, "utf8")).toBe(readFileSync(BUNDLED_COMMAND_CLAUDE, "utf8"));
    expect(existsSync(commandPath(fakeHome, "gemini"))).toBe(false);
  });

  it("refuses to overwrite an existing skill file without --force", () => {
    const fakeHome = makeTmpDir();
    const claudeSkill = skillPath(fakeHome, "claude");
    mkdirSync(join(fakeHome, ".claude", "skills", "agvsr"), { recursive: true });
    writeFileSync(claudeSkill, "sentinel", "utf8");

    const { code, stderr } = runSkillInstall([], { env: { HOME: fakeHome } });
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(readFileSync(claudeSkill, "utf8")).toBe("sentinel");
  });

  it("refuses to overwrite an existing command file without --force", () => {
    const fakeHome = makeTmpDir();
    const claudeCommand = commandPath(fakeHome, "claude");
    mkdirSync(join(fakeHome, ".claude", "commands"), { recursive: true });
    writeFileSync(claudeCommand, "sentinel", "utf8");

    const { code, stderr } = runSkillInstall([], { env: { HOME: fakeHome } });
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(readFileSync(claudeCommand, "utf8")).toBe("sentinel");
  });

  it("with --force overwrites existing skill and command files", () => {
    const fakeHome = makeTmpDir();
    const claudeSkill = skillPath(fakeHome, "claude");
    const claudeCommand = commandPath(fakeHome, "claude");
    mkdirSync(join(fakeHome, ".claude", "skills", "agvsr"), { recursive: true });
    writeFileSync(claudeSkill, "old skill", "utf8");
    mkdirSync(join(fakeHome, ".claude", "commands"), { recursive: true });
    writeFileSync(claudeCommand, "old command", "utf8");

    const { code } = runSkillInstall(["--force"], { env: { HOME: fakeHome } });
    expect(code).toBe(0);
    expect(readFileSync(claudeSkill, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
    expect(readFileSync(claudeCommand, "utf8")).toBe(readFileSync(BUNDLED_COMMAND_CLAUDE, "utf8"));
  });

  it("--target gemini installs only the Gemini skill and command", () => {
    const fakeHome = makeTmpDir();
    const { code } = runSkillInstall(["--target", "gemini"], { env: { HOME: fakeHome } });
    expect(code).toBe(0);

    expect(existsSync(skillPath(fakeHome, "gemini"))).toBe(true);
    expect(readFileSync(skillPath(fakeHome, "gemini"), "utf8")).toBe(
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    expect(existsSync(commandPath(fakeHome, "gemini"))).toBe(true);
    expect(readFileSync(commandPath(fakeHome, "gemini"), "utf8")).toBe(
      readFileSync(BUNDLED_COMMAND_GEMINI, "utf8"),
    );
    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(false);
    expect(existsSync(commandPath(fakeHome, "claude"))).toBe(false);
    expect(existsSync(join(fakeHome, ".codex"))).toBe(false);
  });

  it("--target claude,gemini and repeated flags install both targets' skills and commands", () => {
    const fakeHome = makeTmpDir();
    const { code } = runSkillInstall(["--target", "claude,gemini", "--target", "claude"], {
      env: { HOME: fakeHome },
    });
    expect(code).toBe(0);

    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(true);
    expect(existsSync(skillPath(fakeHome, "gemini"))).toBe(true);
    expect(existsSync(commandPath(fakeHome, "claude"))).toBe(true);
    expect(existsSync(commandPath(fakeHome, "gemini"))).toBe(true);
  });

  it("--target codex writes only to $CODEX_HOME (global, no command file)", () => {
    const fakeHome = makeTmpDir();
    const codexHome = makeTmpDir();
    const realCodexSkill = join(homedir(), ".codex", "skills", "agvsr", "SKILL.md");
    const realCodexExistsBefore = existsSync(realCodexSkill);

    const { code } = runSkillInstall(["--target", "codex"], {
      env: { HOME: fakeHome, CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);

    const codexSkill = join(codexHome, "skills", "agvsr", "SKILL.md");
    expect(existsSync(codexSkill)).toBe(true);
    expect(readFileSync(codexSkill, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
    expect(existsSync(realCodexSkill)).toBe(realCodexExistsBefore);
    expect(existsSync(join(fakeHome, ".claude"))).toBe(false);
    expect(existsSync(join(fakeHome, ".gemini"))).toBe(false);
    expect(existsSync(join(codexHome, "commands"))).toBe(false);
  });

  it("--project <dir> installs under that directory instead of $HOME", () => {
    const fakeHome = makeTmpDir();
    const projectDir = makeTmpDir();

    const { code } = runSkillInstall(["--project", projectDir], { env: { HOME: fakeHome } });
    expect(code).toBe(0);

    expect(existsSync(skillPath(projectDir, "claude"))).toBe(true);
    expect(readFileSync(skillPath(projectDir, "claude"), "utf8")).toBe(
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    expect(existsSync(commandPath(projectDir, "claude"))).toBe(true);
    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(false);
    expect(existsSync(commandPath(fakeHome, "claude"))).toBe(false);
  });

  it("rejects unknown targets before writing anything", () => {
    const fakeHome = makeTmpDir();

    const { code, stderr } = runSkillInstall(["--target", "banana"], { env: { HOME: fakeHome } });
    expect(code).not.toBe(0);
    expect(stderr).toContain('unknown --target "banana"');
    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(false);
    expect(existsSync(commandPath(fakeHome, "claude"))).toBe(false);
  });

  it("--help includes skill/target/project/force options", () => {
    const { code, stdout } = runSkillInstall(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("agvsr skill install");
    expect(stdout).toContain("--skill");
    expect(stdout).toContain("--target");
    expect(stdout).toContain("--project");
    expect(stdout).toContain("--force");
  });

  it("default run never installs self-improve (backward-compat)", () => {
    const fakeHome = makeTmpDir();
    const { code } = runSkillInstall([], { env: { HOME: fakeHome } });
    expect(code).toBe(0);
    expect(existsSync(skillPath(fakeHome, "claude", "self-improve"))).toBe(false);
  });

  it("--skill self-improve installs only the self-improve skill, with no command file", () => {
    const fakeHome = makeTmpDir();
    const { code } = runSkillInstall(["--skill", "self-improve"], { env: { HOME: fakeHome } });
    expect(code).toBe(0);

    const selfImproveSkill = skillPath(fakeHome, "claude", "self-improve");
    expect(existsSync(selfImproveSkill)).toBe(true);
    expect(readFileSync(selfImproveSkill, "utf8")).toBe(
      readFileSync(BUNDLED_SKILL_SELF_IMPROVE, "utf8"),
    );
    expect(existsSync(commandPath(fakeHome, "claude", "self-improve"))).toBe(false);
    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(false);
  });

  it("--skill agvsr,self-improve installs both, command only for agvsr", () => {
    const fakeHome = makeTmpDir();
    const { code } = runSkillInstall(["--skill", "agvsr,self-improve"], {
      env: { HOME: fakeHome },
    });
    expect(code).toBe(0);

    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(true);
    expect(existsSync(skillPath(fakeHome, "claude", "self-improve"))).toBe(true);
    expect(existsSync(commandPath(fakeHome, "claude"))).toBe(true);
    expect(existsSync(commandPath(fakeHome, "claude", "self-improve"))).toBe(false);
  });

  it("--skill self-improve --target gemini,codex writes skill files only, no commands", () => {
    const fakeHome = makeTmpDir();
    const codexHome = makeTmpDir();
    const { code } = runSkillInstall(["--skill", "self-improve", "--target", "gemini,codex"], {
      env: { HOME: fakeHome, CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);

    expect(existsSync(skillPath(fakeHome, "gemini", "self-improve"))).toBe(true);
    expect(existsSync(join(codexHome, "skills", "self-improve", "SKILL.md"))).toBe(true);
    expect(existsSync(commandPath(fakeHome, "gemini", "self-improve"))).toBe(false);
    expect(existsSync(join(codexHome, "commands"))).toBe(false);
  });

  it("rejects unknown --skill values before writing anything", () => {
    const fakeHome = makeTmpDir();

    const { code, stderr } = runSkillInstall(["--skill", "banana"], { env: { HOME: fakeHome } });
    expect(code).not.toBe(0);
    expect(stderr).toContain('unknown --skill "banana"');
    expect(existsSync(skillPath(fakeHome, "claude"))).toBe(false);
  });
});
