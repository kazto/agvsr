import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadTeam, parseTeam } from "../src/config/team.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "src/cli/agvsr.ts");
const BUNDLED_SKILL = join(ROOT, "skills/agvsr/SKILL.md");

function runInit(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(["bun", SCRIPT, "init", ...args], {
    cwd: opts.cwd ?? ROOT,
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

function skillPath(targetDir: string, target: "claude" | "gemini"): string {
  return join(targetDir, `.${target}`, "skills", "agvsr", "SKILL.md");
}

describe("agvsr init CLI", () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("default run writes team.yaml and the bundled Claude skill", () => {
    const cwd = makeTmpDir();
    const { code, stdout, stderr } = runInit([], { cwd });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("wrote ");

    const out = join(cwd, "team.yaml");
    const team = loadTeam(out);
    expect(team.roles.supervisor).toBeDefined();
    expect(Object.keys(team.roles)).toHaveLength(4);
    expect(Object.keys(team.roles)[0]).toBe("supervisor");

    const bundle = readFileSync(BUNDLED_SKILL, "utf8");
    const claudeSkill = skillPath(cwd, "claude");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(readFileSync(claudeSkill, "utf8")).toBe(bundle);
  });

  it("refuses to overwrite an existing target skill file without --force", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");
    const claudeSkill = skillPath(cwd, "claude");
    mkdirSync(join(cwd, ".claude", "skills", "agvsr"), { recursive: true });
    writeFileSync(claudeSkill, "sentinel", "utf8");

    const { code, stderr } = runInit([], { cwd });
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(claudeSkill, "utf8")).toBe("sentinel");
  });

  it("refuses to overwrite an existing team.yaml without --force", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");
    runInit([], { cwd });
    const first = readFileSync(out, "utf8");

    const { code, stderr } = runInit([], { cwd });
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(readFileSync(out, "utf8")).toBe(first);
  });

  it("with --force overwrites existing team.yaml and skill files", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");
    const claudeSkill = skillPath(cwd, "claude");
    writeFileSync(out, "old team", "utf8");
    mkdirSync(join(cwd, ".claude", "skills", "agvsr"), { recursive: true });
    writeFileSync(claudeSkill, "old skill", "utf8");

    const { code } = runInit(["--force"], { cwd });
    expect(code).toBe(0);
    expect(loadTeam(out).roles.supervisor).toBeDefined();
    expect(readFileSync(claudeSkill, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
  });

  it("--skill-target gemini installs only the Gemini skill", () => {
    const cwd = makeTmpDir();
    const { code } = runInit(["--skill-target", "gemini"], { cwd });
    expect(code).toBe(0);

    const out = join(cwd, "team.yaml");
    expect(loadTeam(out).roles.supervisor).toBeDefined();
    expect(existsSync(skillPath(cwd, "gemini"))).toBe(true);
    expect(readFileSync(skillPath(cwd, "gemini"), "utf8")).toBe(
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    expect(existsSync(skillPath(cwd, "claude"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });

  it("--skill-target claude,gemini and repeated flags install both targets", () => {
    const cwd = makeTmpDir();
    const { code } = runInit(["--skill-target", "claude,gemini", "--skill-target", "claude"], {
      cwd,
    });
    expect(code).toBe(0);

    expect(existsSync(skillPath(cwd, "claude"))).toBe(true);
    expect(existsSync(skillPath(cwd, "gemini"))).toBe(true);
    expect(readFileSync(skillPath(cwd, "claude"), "utf8")).toBe(
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
    expect(readFileSync(skillPath(cwd, "gemini"), "utf8")).toBe(
      readFileSync(BUNDLED_SKILL, "utf8"),
    );
  });

  it("--no-skill skips all skill installs even when --skill-target is present", () => {
    const cwd = makeTmpDir();
    const { code } = runInit(["--no-skill", "--skill-target", "claude,gemini"], { cwd });
    expect(code).toBe(0);

    const out = join(cwd, "team.yaml");
    expect(loadTeam(out).roles.supervisor).toBeDefined();
    expect(existsSync(skillPath(cwd, "claude"))).toBe(false);
    expect(existsSync(skillPath(cwd, "gemini"))).toBe(false);
  });

  it("--stdout prints only YAML and ignores file preflight and skill install", () => {
    const cwd = makeTmpDir();
    const codexHome = makeTmpDir();
    const out = join(cwd, "team.yaml");
    const realCodexSkill = join(homedir(), ".codex", "skills", "agvsr", "SKILL.md");
    const realCodexExistsBefore = existsSync(realCodexSkill);
    writeFileSync(out, "sentinel team", "utf8");
    mkdirSync(join(codexHome, "skills", "agvsr"), { recursive: true });
    writeFileSync(join(codexHome, "skills", "agvsr", "SKILL.md"), "sentinel skill", "utf8");

    const { code, stdout, stderr } = runInit(["--stdout", "--skill-target", "codex"], {
      cwd,
      env: { CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const team = parseTeam(stdout);
    expect(team.roles.supervisor).toBeDefined();
    expect(readFileSync(out, "utf8")).toBe("sentinel team");
    expect(readFileSync(join(codexHome, "skills", "agvsr", "SKILL.md"), "utf8")).toBe(
      "sentinel skill",
    );
    expect(existsSync(realCodexSkill)).toBe(realCodexExistsBefore);
    expect(existsSync(skillPath(cwd, "claude"))).toBe(false);
    expect(existsSync(skillPath(cwd, "gemini"))).toBe(false);
  });

  it("--skill-target codex writes to CODEX_HOME without touching the real home directory", () => {
    const cwd = makeTmpDir();
    const codexHome = makeTmpDir();
    const realCodexSkill = join(homedir(), ".codex", "skills", "agvsr", "SKILL.md");
    const realCodexExistsBefore = existsSync(realCodexSkill);

    const { code } = runInit(["--skill-target", "codex"], {
      cwd,
      env: { CODEX_HOME: codexHome },
    });
    expect(code).toBe(0);

    const codexSkill = join(codexHome, "skills", "agvsr", "SKILL.md");
    expect(existsSync(codexSkill)).toBe(true);
    expect(readFileSync(codexSkill, "utf8")).toBe(readFileSync(BUNDLED_SKILL, "utf8"));
    expect(existsSync(realCodexSkill)).toBe(realCodexExistsBefore);
  });

  it("rejects unknown skill targets before writing anything", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");

    const { code, stderr } = runInit(["--skill-target", "banana"], { cwd });
    expect(code).not.toBe(0);
    expect(stderr).toContain('unknown --skill-target "banana"');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(skillPath(cwd, "claude"))).toBe(false);
    expect(existsSync(skillPath(cwd, "gemini"))).toBe(false);
  });

  it("--help includes skill-target and no-skill options", () => {
    const { code, stdout } = runInit(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("agvsr init");
    expect(stdout).toContain("--stdout");
    expect(stdout).toContain("--force");
    expect(stdout).toContain("--no-skill");
    expect(stdout).toContain("--skill-target");
  });
});
