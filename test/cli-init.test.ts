import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTeam, parseTeam } from "../src/config/team.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "src/cli/agvsr.ts");

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

  it("default run writes team.yaml", () => {
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

  it("with --force overwrites an existing team.yaml", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");
    writeFileSync(out, "old team", "utf8");

    const { code } = runInit(["--force"], { cwd });
    expect(code).toBe(0);
    expect(loadTeam(out).roles.supervisor).toBeDefined();
  });

  it("--stdout prints only YAML and ignores file preflight", () => {
    const cwd = makeTmpDir();
    const out = join(cwd, "team.yaml");
    writeFileSync(out, "sentinel team", "utf8");

    const { code, stdout, stderr } = runInit(["--stdout"], { cwd });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const team = parseTeam(stdout);
    expect(team.roles.supervisor).toBeDefined();
    expect(readFileSync(out, "utf8")).toBe("sentinel team");
  });

  it("--help does not mention removed skill-install options", () => {
    const { code, stdout } = runInit(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("agvsr init");
    expect(stdout).toContain("--stdout");
    expect(stdout).toContain("--force");
    expect(stdout).not.toContain("--no-skill");
    expect(stdout).not.toContain("--skill-target");
  });
});
