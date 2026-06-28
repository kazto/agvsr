import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, reportHasFailures, defaultDeps, type DoctorDeps } from "../src/doctor.ts";
import { resolveTeamFile } from "../src/config/team.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const VALID_TEAM_SINGLE = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
`;

const VALID_TEAM_ALL_ADAPTERS = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  worker1: { adapter: codex, model: gpt-5-codex }
  worker2: { adapter: agy, model: gemini-3-pro }
`;

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loginPath: async () => "/injected/bin:/other/bin",
    which: (_bin, _pathStr) => null,
    getEnv: (_name) => undefined,
    fileExists: (_path) => false,
    homeDir: () => "/home/testuser",
    readFile: (_path) => VALID_TEAM_SINGLE,
    probeModel: async () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
    ...overrides,
  };
}

function writeDummyBinary(dir: string, name: string, validModels: string[]): string {
  const path = join(dir, name);
  const script = `#!/bin/sh
set -eu
model=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--model" ] || [ "$prev" = "-m" ]; then
    model="$arg"
    break
  fi
  prev="$arg"
done
case "$model" in
${validModels.map((model) => `  ${model}) exit 0 ;;`).join("\n")}
  *)
    echo "unknown model: $model" >&2
    exit 1
    ;;
esac
`;
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

async function runDoctorCli(
  teamFile: string,
  extraEnv: Record<string, string>,
  extraArgs: string[] = [],
) {
  const cliPath = join(import.meta.dir, "../src/cli/agvsr.ts");
  const proc = Bun.spawn(
    [process.execPath, "run", cliPath, "doctor", "--team", teamFile, ...extraArgs],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...extraEnv },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// ── QA 1: team source precedence ─────────────────────────────────────────────

describe("resolveTeamFile (team source precedence)", () => {
  const origEnv = process.env.AGVSR_TEAM;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.AGVSR_TEAM;
    } else {
      process.env.AGVSR_TEAM = origEnv;
    }
  });

  it("returns explicit path when provided (highest precedence)", () => {
    process.env.AGVSR_TEAM = "/env/team.yaml";
    expect(resolveTeamFile("/explicit/team.yaml")).toBe("/explicit/team.yaml");
  });

  it("falls back to AGVSR_TEAM when no explicit path", () => {
    process.env.AGVSR_TEAM = "/env/team.yaml";
    expect(resolveTeamFile()).toBe("/env/team.yaml");
  });

  it("falls back to cwd/team.yaml when neither explicit nor env is set", () => {
    delete process.env.AGVSR_TEAM;
    expect(resolveTeamFile()).toBe(join(process.cwd(), "team.yaml"));
  });

  it("runDoctor reports the resolved team path in the report", async () => {
    const deps = makeDeps();
    const report = await runDoctor("/resolved/team.yaml", deps);
    expect(report.teamFile).toBe("/resolved/team.yaml");
  });
});

// ── QA 2: PATH resolution ─────────────────────────────────────────────────────

describe("PATH resolution", () => {
  it("passes injected loginPath to which()", async () => {
    let capturedPath: string | undefined;
    const deps = makeDeps({
      loginPath: async () => "/injected/bin:/usr/local/bin",
      which: (bin, pathStr) => {
        capturedPath = pathStr;
        return `/injected/bin/${bin}`;
      },
    });
    await runDoctor("/team.yaml", deps);
    expect(capturedPath).toBe("/injected/bin:/usr/local/bin");
  });

  it("does not use process.env.PATH directly (uses injected dep)", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/should-not-be-used";
    let capturedPath: string | undefined;
    try {
      const deps = makeDeps({
        loginPath: async () => "/custom-injected-path",
        which: (_bin, pathStr) => {
          capturedPath = pathStr;
          return null;
        },
      });
      await runDoctor("/team.yaml", deps);
    } finally {
      process.env.PATH = origPath;
    }
    expect(capturedPath).toBe("/custom-injected-path");
  });
});

// ── QA 3: schema failure ──────────────────────────────────────────────────────

describe("schema failure (hard fail)", () => {
  it("fails on malformed YAML", async () => {
    const deps = makeDeps({ readFile: () => "{ not: valid yaml: [" });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
    expect(report.groups[0]?.checks.some((c) => c.level === "fail")).toBe(true);
  });

  it("fails on invalid schema (missing supervisor role)", async () => {
    const deps = makeDeps({
      readFile: () => "roles:\n  worker: { adapter: codex, model: gpt-5 }",
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });

  it("fails on unknown adapter", async () => {
    const deps = makeDeps({
      readFile: () => "roles:\n  supervisor: { adapter: cursor, model: m }",
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });

  it("stops after schema failure (no adapter/auth sections)", async () => {
    const deps = makeDeps({ readFile: () => "{ not: valid yaml: [" });
    const report = await runDoctor("/team.yaml", deps);
    expect(report.groups.length).toBe(1);
  });

  it("fails when team file cannot be read", async () => {
    const deps = makeDeps({
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    const report = await runDoctor("/nonexistent/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });
});

// ── QA 4: missing adapter binary ─────────────────────────────────────────────

describe("missing adapter binary (hard fail)", () => {
  it("fails with role names when adapter binary is missing", async () => {
    const deps = makeDeps({ which: () => null });
    const report = await runDoctor("/team.yaml", deps);
    const binGroup = report.groups.find((g) => g.title === "adapter binaries");
    const codexCheck = binGroup?.checks.find((c) => c.label === "codex");
    expect(codexCheck?.level).toBe("fail");
    expect(codexCheck?.message).toContain("implementation");
    expect(reportHasFailures(report)).toBe(true);
  });

  it("fails claude binary and mentions dependent role", async () => {
    const deps = makeDeps({
      which: (bin) => (bin === "codex" ? "/usr/bin/codex" : null),
    });
    const report = await runDoctor("/team.yaml", deps);
    const binGroup = report.groups.find((g) => g.title === "adapter binaries");
    const claudeCheck = binGroup?.checks.find((c) => c.label === "claude");
    expect(claudeCheck?.level).toBe("fail");
    expect(claudeCheck?.message).toContain("supervisor");
  });

  it("shows ok when binary is found", async () => {
    const deps = makeDeps({ which: (bin) => `/usr/bin/${bin}` });
    const report = await runDoctor("/team.yaml", deps);
    const binGroup = report.groups.find((g) => g.title === "adapter binaries");
    expect(binGroup?.checks.every((c) => c.level === "ok")).toBe(true);
  });

  it("lists all roles for an adapter when multiple roles share it", async () => {
    const deps = makeDeps({
      which: () => null,
      readFile: () => `
roles:
  supervisor: { adapter: claude-code, model: m }
  design: { adapter: claude-code, model: m }
  implementation: { adapter: claude-code, model: m }
`,
    });
    const report = await runDoctor("/team.yaml", deps);
    const binGroup = report.groups.find((g) => g.title === "adapter binaries");
    const claudeCheck = binGroup?.checks.find((c) => c.label === "claude");
    expect(claudeCheck?.level).toBe("fail");
    expect(claudeCheck?.message).toContain("supervisor");
    expect(claudeCheck?.message).toContain("design");
    expect(claudeCheck?.message).toContain("implementation");
  });
});

// ── QA 5: auth/config missing (warn-only) ────────────────────────────────────

describe("auth check (warn-only)", () => {
  it("warns but does not fail when no auth is configured", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: () => undefined,
      fileExists: () => false,
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    expect(authGroup?.checks.every((c) => c.level !== "fail")).toBe(true);
    expect(authGroup?.checks.some((c) => c.level === "warn")).toBe(true);
    expect(reportHasFailures(report)).toBe(false);
  });

  it("claude-code auth ok via ANTHROPIC_API_KEY", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: (name) => (name === "ANTHROPIC_API_KEY" ? "sk-test" : undefined),
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const claudeAuth = authGroup?.checks.find((c) => c.label === "claude-code auth");
    expect(claudeAuth?.level).toBe("ok");
    expect(claudeAuth?.message).toContain("ANTHROPIC_API_KEY");
  });

  it("claude-code auth ok via ~/.claude/.credentials.json", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: () => undefined,
      fileExists: (path) => path === "/home/testuser/.claude/.credentials.json",
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const claudeAuth = authGroup?.checks.find((c) => c.label === "claude-code auth");
    expect(claudeAuth?.level).toBe("ok");
  });

  it("claude-code auth ok via ~/.claude.json", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: () => undefined,
      fileExists: (path) => path === "/home/testuser/.claude.json",
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const claudeAuth = authGroup?.checks.find((c) => c.label === "claude-code auth");
    expect(claudeAuth?.level).toBe("ok");
  });

  it("codex auth ok via OPENAI_API_KEY", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: (name) => (name === "OPENAI_API_KEY" ? "sk-test" : undefined),
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const codexAuth = authGroup?.checks.find((c) => c.label === "codex auth");
    expect(codexAuth?.level).toBe("ok");
  });

  it("codex auth ok via ~/.codex/auth.json", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: () => undefined,
      fileExists: (path) => path === "/home/testuser/.codex/auth.json",
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const codexAuth = authGroup?.checks.find((c) => c.label === "codex auth");
    expect(codexAuth?.level).toBe("ok");
  });

  it("agy auth ok via GEMINI_API_KEY", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      getEnv: (name) => (name === "GEMINI_API_KEY" ? "key" : undefined),
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const agyAuth = authGroup?.checks.find((c) => c.label === "agy auth");
    expect(agyAuth?.level).toBe("ok");
  });

  it("agy auth ok via GOOGLE_API_KEY", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      getEnv: (name) => (name === "GOOGLE_API_KEY" ? "key" : undefined),
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const agyAuth = authGroup?.checks.find((c) => c.label === "agy auth");
    expect(agyAuth?.level).toBe("ok");
  });

  it("agy auth ok via ~/.gemini/antigravity-cli/ directory", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      getEnv: () => undefined,
      fileExists: (path) => path === "/home/testuser/.gemini/antigravity-cli",
    });
    const report = await runDoctor("/team.yaml", deps);
    const authGroup = report.groups.find((g) => g.title === "auth");
    const agyAuth = authGroup?.checks.find((c) => c.label === "agy auth");
    expect(agyAuth?.level).toBe("ok");
  });
});

// ── QA 6: model shape validation ─────────────────────────────────────────────

describe("model shape validation", () => {
  it("rejects empty model string (schema catches it)", async () => {
    const deps = makeDeps({
      readFile: () => "roles:\n  supervisor: { adapter: claude-code, model: '' }",
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });

  it("rejects missing model field", async () => {
    const deps = makeDeps({
      readFile: () => "roles:\n  supervisor: { adapter: claude-code }",
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });

  it("accepts any non-empty model string without probing", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => "roles:\n  supervisor: { adapter: claude-code, model: any-string-no-probe }",
    });
    const report = await runDoctor("/team.yaml", deps);
    const schemaCheck = report.groups[0]?.checks.find((c) => c.label === "schema");
    expect(schemaCheck?.level).toBe("ok");
  });

  it("warns on obvious Claude shorthand typos without failing", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => `
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
`,
    });
    const report = await runDoctor("/team.yaml", deps);
    const modelGroup = report.groups.find((g) => g.title === "model warnings");
    expect(modelGroup?.checks.some((c) => c.level === "warn")).toBe(true);
    expect(modelGroup?.checks.some((c) => c.message.includes("claude-opus-4-8"))).toBe(true);
    expect(reportHasFailures(report)).toBe(false);
  });

  it("keeps JSON ok true when warnings are the only issue", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      readFile: () => `
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
`,
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(false);
    expect(report.teamFile).toBe("/team.yaml");
    expect(!reportHasFailures(report)).toBe(true);
    expect(report.groups.map((g) => g.title)).toEqual([
      "team.yaml",
      "model warnings",
      "adapter binaries",
      "auth",
    ]);
  });
});

// ── QA 7: model probing ─────────────────────────────────────────────────────

describe("model probing", () => {
  it("does not invoke probeModel unless probe mode is enabled", async () => {
    let calls = 0;
    const deps = makeDeps({
      probeModel: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "OK", stderr: "" };
      },
    });
    await runDoctor("/team.yaml", deps);
    expect(calls).toBe(0);
  });

  it("probes roles in team.yaml order when enabled", async () => {
    const calls: Array<{ role: string; adapter: string; model: string }> = [];
    const deps = makeDeps({
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      which: (bin) => `/usr/bin/${bin}`,
      probeModel: async (spec) => {
        calls.push({ role: spec.role, adapter: spec.adapter, model: spec.model });
        return { exitCode: 0, stdout: "OK", stderr: "" };
      },
    });
    await runDoctor("/team.yaml", deps, { probe: true });
    expect(calls).toEqual([
      { role: "supervisor", adapter: "claude-code", model: "claude-opus-4-8" },
      { role: "worker1", adapter: "codex", model: "gpt-5-codex" },
      { role: "worker2", adapter: "agy", model: "gemini-3-pro" },
    ]);
  });

  it("adds a model probes group with ok checks when probes pass", async () => {
    const deps = makeDeps({
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      which: (bin) => `/usr/bin/${bin}`,
      probeModel: async () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
    });
    const report = await runDoctor("/team.yaml", deps, { probe: true });
    const probeGroup = report.groups.find((g) => g.title === "model probes");
    expect(probeGroup?.checks.every((c) => c.level === "ok")).toBe(true);
    expect(reportHasFailures(report)).toBe(false);
  });

  it("reports probe failures with remediation hints", async () => {
    const deps = makeDeps({
      readFile: () => VALID_TEAM_SINGLE,
      which: (bin) => `/usr/bin/${bin}`,
      probeModel: async () => ({ exitCode: 1, stdout: "", stderr: "unknown model" }),
    });
    const report = await runDoctor("/team.yaml", deps, { probe: true });
    const probeGroup = report.groups.find((g) => g.title === "model probes");
    const supervisorCheck = probeGroup?.checks.find((c) => c.label.startsWith("supervisor "));
    expect(supervisorCheck?.level).toBe("fail");
    expect(supervisorCheck?.message).toContain('team.yaml supervisor.model="claude-opus-4-8"');
    expect(supervisorCheck?.message).toContain("login/API key");
    expect(supervisorCheck?.message).toContain("PATH/install");
    expect(supervisorCheck?.message).toContain("unknown model");
    expect(reportHasFailures(report)).toBe(true);
  });

  it("skips probing when an adapter binary is missing", async () => {
    let calls = 0;
    const deps = makeDeps({
      readFile: () => VALID_TEAM_ALL_ADAPTERS,
      which: (bin) => (bin === "claude" ? null : `/usr/bin/${bin}`),
      probeModel: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "OK", stderr: "" };
      },
    });
    const report = await runDoctor("/team.yaml", deps, { probe: true });
    const binGroup = report.groups.find((g) => g.title === "adapter binaries");
    const claudeBin = binGroup?.checks.find((c) => c.label === "claude");
    expect(claudeBin?.level).toBe("fail");
    const probeGroup = report.groups.find((g) => g.title === "model probes");
    const supervisorCheck = probeGroup?.checks.find((c) => c.label.startsWith("supervisor "));
    expect(supervisorCheck?.level).toBe("fail");
    expect(supervisorCheck?.message).toContain(
      "skipped probe because claude is not available in PATH",
    );
    expect(calls).toBe(2);
    expect(reportHasFailures(report)).toBe(true);
  });
});

// ── QA 7: aggregation ────────────────────────────────────────────────────────

describe("aggregation (warn + fail → exit 1)", () => {
  it("reportHasFailures true when any check fails", async () => {
    const deps = makeDeps({ which: () => null });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(true);
  });

  it("reportHasFailures false with only warnings", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: () => undefined,
      fileExists: () => false,
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(reportHasFailures(report)).toBe(false);
    const allChecks = report.groups.flatMap((g) => g.checks);
    expect(allChecks.some((c) => c.level === "warn")).toBe(true);
  });

  it("all groups and findings present in a mixed warn+fail report", async () => {
    // binary missing (fail) + auth missing (warn)
    const deps = makeDeps({ which: () => null });
    const report = await runDoctor("/team.yaml", deps);
    const levels = report.groups.flatMap((g) => g.checks.map((c) => c.level));
    expect(levels).toContain("fail");
    expect(levels).toContain("warn");
    expect(report.groups.length).toBe(4);
  });
});

// ── QA 8: JSON parity ────────────────────────────────────────────────────────

describe("JSON output parity", () => {
  it("report has stable, machine-readable structure", async () => {
    const deps = makeDeps({ which: (bin) => `/usr/bin/${bin}` });
    const report = await runDoctor("/team.yaml", deps);
    const json = {
      team_file: report.teamFile,
      ok: !reportHasFailures(report),
      groups: report.groups,
    };
    expect(json.team_file).toBe("/team.yaml");
    expect(typeof json.ok).toBe("boolean");
    expect(Array.isArray(json.groups)).toBe(true);
    for (const group of json.groups) {
      expect(typeof group.title).toBe("string");
      expect(Array.isArray(group.checks)).toBe(true);
      for (const check of group.checks) {
        expect(typeof check.label).toBe("string");
        expect(["ok", "warn", "fail"]).toContain(check.level);
        expect(typeof check.message).toBe("string");
      }
    }
  });

  it("ok field is false when any fail is present", async () => {
    const deps = makeDeps({ which: () => null });
    const report = await runDoctor("/team.yaml", deps);
    expect(!reportHasFailures(report)).toBe(false);
  });

  it("ok field is true when no fails", async () => {
    const deps = makeDeps({
      which: (bin) => `/usr/bin/${bin}`,
      getEnv: (name) => (name === "ANTHROPIC_API_KEY" ? "sk-x" : undefined),
    });
    const report = await runDoctor("/team.yaml", deps);
    expect(!reportHasFailures(report)).toBe(true);
  });

  it("groups order matches: team.yaml → model warnings → adapter binaries → auth", async () => {
    const deps = makeDeps({ which: (bin) => `/usr/bin/${bin}` });
    const report = await runDoctor("/team.yaml", deps);
    expect(report.groups.map((g) => g.title)).toEqual([
      "team.yaml",
      "model warnings",
      "adapter binaries",
      "auth",
    ]);
  });
});

// ── QA 9: read-only / daemon-independent ─────────────────────────────────────

describe("read-only / daemon-independent", () => {
  it("runDoctor completes without a running daemon", async () => {
    const deps = makeDeps({ which: (bin) => `/usr/bin/${bin}` });
    const report = await runDoctor("/team.yaml", deps);
    expect(report).toBeDefined();
    expect(report.groups.length).toBeGreaterThan(0);
  });

  it("defaultDeps() returns a complete DoctorDeps object", () => {
    const deps = defaultDeps();
    expect(typeof deps.loginPath).toBe("function");
    expect(typeof deps.which).toBe("function");
    expect(typeof deps.getEnv).toBe("function");
    expect(typeof deps.fileExists).toBe("function");
    expect(typeof deps.homeDir).toBe("function");
    expect(typeof deps.readFile).toBe("function");
    expect(typeof deps.probeModel).toBe("function");
  });
});

// ── CLI integration (e2e-ish) ────────────────────────────────────────────────

describe("CLI integration", () => {
  let tmpDir: string;
  let teamFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agvsr-doctor-"));
    teamFile = join(tmpDir, "team.yaml");
    writeFileSync(
      teamFile,
      `roles:\n  supervisor: { adapter: claude-code, model: claude-opus-4-8 }\n`,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--json produces valid JSON with expected keys", async () => {
    const cliPath = join(import.meta.dir, "../src/cli/agvsr.ts");
    const proc = Bun.spawn(["bun", "run", cliPath, "doctor", "--team", teamFile, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const json = JSON.parse(stdout) as unknown;
    expect(typeof (json as { ok: boolean }).ok).toBe("boolean");
    expect((json as { team_file: string }).team_file).toBe(teamFile);
    expect(Array.isArray((json as { groups: unknown[] }).groups)).toBe(true);
  });

  it("exits 1 and reports fail when team file does not exist", async () => {
    const cliPath = join(import.meta.dir, "../src/cli/agvsr.ts");
    const proc = Bun.spawn(
      ["bun", "run", cliPath, "doctor", "--team", join(tmpDir, "nonexistent.yaml")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(1);
    expect(stdout).toContain("✗");
  });

  it("human output includes group titles and markers", async () => {
    const cliPath = join(import.meta.dir, "../src/cli/agvsr.ts");
    const proc = Bun.spawn(["bun", "run", cliPath, "doctor", "--team", teamFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("team.yaml");
    expect(stdout).toContain(teamFile);
    expect(stdout).toContain("adapter binaries");
    expect(stdout).toContain("auth");
  });

  it("--probe succeeds with a temporary dummy adapter binary on PATH", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "agvsr-doctor-bin-"));
    const dummyBin = writeDummyBinary(binDir, "codex", ["gpt-5-codex"]);
    const probeTeam = join(tmpDir, "probe-team.yaml");
    writeFileSync(probeTeam, `roles:\n  supervisor: { adapter: codex, model: gpt-5-codex }\n`);
    const { stdout, code } = await runDoctorCli(probeTeam, { PATH: binDir, SHELL: "" }, [
      "--probe",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("model probes");
    expect(stdout).toContain("✓");
    expect(stdout).toContain(dummyBin);
  });

  it("--probe fails with a dummy adapter binary that rejects an unknown model", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "agvsr-doctor-bin-"));
    writeDummyBinary(binDir, "codex", ["gpt-5-codex"]);
    const probeTeam = join(tmpDir, "probe-team-invalid.yaml");
    writeFileSync(probeTeam, `roles:\n  supervisor: { adapter: codex, model: invalid-model }\n`);
    const { stdout, code } = await runDoctorCli(probeTeam, { PATH: binDir, SHELL: "" }, [
      "--probe",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("✗");
    expect(stdout).toContain("unknown model");
    expect(stdout).toContain('team.yaml supervisor.model="invalid-model"');
  });

  it("--probe reports a missing adapter binary without spawning a probe", async () => {
    const probeTeam = join(tmpDir, "probe-team-missing.yaml");
    writeFileSync(
      probeTeam,
      `roles:\n  supervisor: { adapter: claude-code, model: claude-opus-4-8 }\n`,
    );
    const { stdout, code } = await runDoctorCli(probeTeam, { PATH: tmpDir, SHELL: "" }, [
      "--probe",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("adapter binaries");
    expect(stdout).toContain("model probes");
    expect(stdout).toContain("skipped probe because claude is not available in PATH");
  });
});
