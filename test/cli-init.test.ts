import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTeam, parseTeam } from "../src/config/team.ts";

const cwd = process.cwd();

function runInit(args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", "src/cli/agvsr.ts", "init", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("agvsr init CLI", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("happy path: writes valid team.yaml; exit 0", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code, stderr } = runInit(["-o", out]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const team = loadTeam(out);
    expect(team.roles.supervisor).toBeDefined();
    expect(Object.keys(team.roles)).toHaveLength(4);
    expect(Object.keys(team.roles)[0]).toBe("supervisor");
  });

  it("second run without --force: non-zero exit, file unchanged", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    runInit(["-o", out]);
    const first = readFileSync(out, "utf8");
    const { code, stderr } = runInit(["-o", out]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("already exists");
    expect(readFileSync(out, "utf8")).toBe(first);
  });

  it("--force overwrites existing file; exit 0", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    runInit(["-o", out]);
    const { code } = runInit(["-o", out, "--force"]);
    expect(code).toBe(0);
    const team = loadTeam(out);
    expect(team.roles.supervisor).toBeDefined();
  });

  it("--stdout: valid YAML on stdout, no file written", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code, stdout } = runInit(["--stdout"]);
    expect(code).toBe(0);
    const team = parseTeam(stdout);
    expect(team.roles.supervisor).toBeDefined();
    expect(existsSync(out)).toBe(false);
  });

  it("--adapter codex: all roles use codex", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code } = runInit(["-o", out, "--adapter", "codex"]);
    expect(code).toBe(0);
    const team = loadTeam(out);
    for (const role of Object.values(team.roles)) {
      expect(role.adapter).toBe("codex");
    }
  });

  it("--model: overrides default model for all roles", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code } = runInit(["-o", out, "--model", "my-custom-model"]);
    expect(code).toBe(0);
    const team = loadTeam(out);
    for (const role of Object.values(team.roles)) {
      expect(role.model).toBe("my-custom-model");
    }
  });

  it("--role per-role override applied", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code } = runInit(["-o", out, "--role", "implementation:codex:gpt-5.5"]);
    expect(code).toBe(0);
    const team = loadTeam(out);
    expect(team.roles.implementation?.adapter).toBe("codex");
    expect(team.roles.implementation?.model).toBe("gpt-5.5");
    expect(team.roles.supervisor?.adapter).toBe("claude-code");
  });

  it("unknown --adapter: exits non-zero before writing", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code, stderr } = runInit(["-o", out, "--adapter", "bad-ai"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("bad-ai");
    expect(existsSync(out)).toBe(false);
  });

  it("supervisor auto-prepended when missing from --roles", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code, stderr } = runInit(["-o", out, "--roles", "design,implementation"]);
    expect(code).toBe(0);
    expect(stderr).toContain("supervisor");
    const team = loadTeam(out);
    expect(team.roles.supervisor).toBeDefined();
  });

  it("--no-comments: output has no header or hooks comment", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-init-"));
    const out = join(tmpDir, "team.yaml");
    const { code } = runInit(["-o", out, "--no-comments"]);
    expect(code).toBe(0);
    const content = readFileSync(out, "utf8");
    expect(content).not.toContain("# Generated");
    expect(content).not.toContain("# hooks");
    const team = loadTeam(out);
    expect(team.roles.supervisor).toBeDefined();
  });

  it("--help: prints usage; exit 0", () => {
    const { code, stdout } = runInit(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("agvsr init");
    expect(stdout).toContain("--stdout");
    expect(stdout).toContain("--force");
  });
});
