import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allowedTargets, findTeamFile, parseTeam, TeamConfigError } from "../src/config/team.ts";

const VALID = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  design: { adapter: claude-code, model: claude-sonnet-4-6 }
  implementation: { adapter: codex, model: gpt-5-codex }
  qa: { adapter: agy, model: gemini-3-pro }
`;

describe("parseTeam", () => {
  it("parses a valid team", () => {
    const team = parseTeam(VALID);
    expect(Object.keys(team.roles)).toEqual(["supervisor", "design", "implementation", "qa"]);
    expect(team.roles.implementation!.adapter).toBe("codex");
  });

  it("requires a supervisor role", () => {
    expect(() => parseTeam(`roles:\n  design: { adapter: codex, model: m }`)).toThrow(
      TeamConfigError,
    );
  });

  it("rejects unknown adapters", () => {
    expect(() => parseTeam(`roles:\n  supervisor: { adapter: cursor, model: m }`)).toThrow(
      TeamConfigError,
    );
  });

  it("rejects a role missing a model", () => {
    expect(() => parseTeam(`roles:\n  supervisor: { adapter: codex }`)).toThrow(TeamConfigError);
  });

  it("carries a team-level env through to the config", () => {
    const team = parseTeam(
      `env:\n  DATABASE_TEST_URL: postgres://x/y\nroles:\n  supervisor: { adapter: codex, model: m }`,
    );
    expect(team.env).toEqual({ DATABASE_TEST_URL: "postgres://x/y" });
  });

  it("carries a per-role env alongside the team-level one", () => {
    const team = parseTeam(
      `env:\n  SHARED: "1"\nroles:\n  supervisor: { adapter: codex, model: m }\n` +
        `  qa: { adapter: codex, model: m, env: { DATABASE_TEST_URL: "postgres://q" } }`,
    );
    expect(team.env).toEqual({ SHARED: "1" });
    expect(team.roles.qa!.env).toEqual({ DATABASE_TEST_URL: "postgres://q" });
  });

  it("rejects a non-string env value", () => {
    expect(() =>
      parseTeam(`env:\n  PORT: 5433\nroles:\n  supervisor: { adapter: codex, model: m }`),
    ).toThrow(TeamConfigError);
  });

  it("network_access defaults to undefined (opt-in, not required)", () => {
    const team = parseTeam(VALID);
    expect(team.roles.qa!.network_access).toBeUndefined();
  });

  it("accepts an explicit network_access: true on a role", () => {
    const team = parseTeam(
      `roles:\n  supervisor: { adapter: codex, model: m }\n  qa: { adapter: codex, model: m, network_access: true }`,
    );
    expect(team.roles.qa!.network_access).toBe(true);
  });

  it("rejects a non-boolean network_access", () => {
    expect(() =>
      parseTeam(`roles:\n  supervisor: { adapter: codex, model: m, network_access: "yes" }`),
    ).toThrow(TeamConfigError);
  });
});

describe("array-valued implementation (D27, multiple worktree-isolated instances)", () => {
  const ARRAY_TEAM = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation:
    - { adapter: codex, model: gpt-5.5 }
    - { adapter: claude-code, model: claude-opus-4-8 }
`;

  it("expands into implementation-1/implementation-2 with charter_role auto-set", () => {
    const team = parseTeam(ARRAY_TEAM);
    expect(Object.keys(team.roles)).toEqual(["supervisor", "implementation-1", "implementation-2"]);
    expect(team.roles["implementation-1"]!.adapter).toBe("codex");
    expect(team.roles["implementation-1"]!.charter_role).toBe("implementation");
    expect(team.roles["implementation-2"]!.adapter).toBe("claude-code");
    expect(team.roles["implementation-2"]!.charter_role).toBe("implementation");
    expect(team.roles.implementation).toBeUndefined();
  });

  it("lets an explicit charter_role on an array entry win over the auto-set default", () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  implementation:
    - { adapter: codex, model: m, charter_role: custom-impl }
`);
    expect(team.roles["implementation-1"]!.charter_role).toBe("custom-impl");
  });

  it("leaves a non-array implementation role unaffected", () => {
    const team = parseTeam(VALID);
    expect(team.roles.implementation!.charter_role).toBeUndefined();
  });

  it("rejects array values for any role other than implementation", () => {
    expect(() =>
      parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  qa:
    - { adapter: codex, model: m }
    - { adapter: agy, model: m }
`),
    ).toThrow(TeamConfigError);
    expect(() =>
      parseTeam(`
roles:
  supervisor:
    - { adapter: claude-code, model: m }
`),
    ).toThrow(TeamConfigError);
  });

  it("array-expanded instances are addressable like any other role", () => {
    const team = parseTeam(ARRAY_TEAM);
    expect(allowedTargets(team, "supervisor").sort()).toEqual(
      ["implementation-1", "implementation-2", "user"].sort(),
    );
    expect(allowedTargets(team, "implementation-1")).toEqual(["supervisor"]);
  });
});

describe("parseTeam (TOML)", () => {
  const VALID_TOML = `
[roles.supervisor]
adapter = "claude-code"
model = "claude-opus-4-8"

[roles.design]
adapter = "claude-code"
model = "claude-sonnet-4-6"

[roles.qa]
adapter = "agy"
model = "gemini-3-pro"
`;

  it("parses a valid team", () => {
    const team = parseTeam(VALID_TOML, "toml");
    expect(Object.keys(team.roles)).toEqual(["supervisor", "design", "qa"]);
    expect(team.roles.design!.adapter).toBe("claude-code");
  });

  it("expands array-valued implementation (array of tables)", () => {
    const team = parseTeam(
      `
[roles.supervisor]
adapter = "claude-code"
model = "m"

[[roles.implementation]]
adapter = "codex"
model = "gpt-5.5"

[[roles.implementation]]
adapter = "claude-code"
model = "m"
`,
      "toml",
    );
    expect(Object.keys(team.roles)).toEqual(["supervisor", "implementation-1", "implementation-2"]);
    expect(team.roles["implementation-1"]!.adapter).toBe("codex");
    expect(team.roles["implementation-1"]!.charter_role).toBe("implementation");
  });

  it("requires a supervisor role", () => {
    expect(() => parseTeam(`[roles.design]\nadapter = "codex"\nmodel = "m"\n`, "toml")).toThrow(
      TeamConfigError,
    );
  });

  it("rejects unknown adapters", () => {
    expect(() =>
      parseTeam(`[roles.supervisor]\nadapter = "cursor"\nmodel = "m"\n`, "toml"),
    ).toThrow(TeamConfigError);
  });

  it("reports errors with team.toml in the message, not team.yaml", () => {
    expect(() => parseTeam(`not valid toml =`, "toml")).toThrow(/team\.toml/);
  });

  it("rejects invalid TOML syntax", () => {
    expect(() => parseTeam(`[roles.supervisor\nadapter = "codex"`, "toml")).toThrow(
      TeamConfigError,
    );
  });
});

describe("findTeamFile", () => {
  let dir: string;

  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it("returns null when neither file exists", () => {
    dir = mkdtempSync(join(tmpdir(), "agvsr-find-team-"));
    try {
      expect(findTeamFile(dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("finds team.toml when only it exists", () => {
    dir = mkdtempSync(join(tmpdir(), "agvsr-find-team-"));
    try {
      const tomlPath = join(dir, "team.toml");
      writeFileSync(tomlPath, "", "utf8");
      expect(findTeamFile(dir)).toBe(tomlPath);
    } finally {
      cleanup();
    }
  });

  it("finds team.yaml when only it exists", () => {
    dir = mkdtempSync(join(tmpdir(), "agvsr-find-team-"));
    try {
      const yamlPath = join(dir, "team.yaml");
      writeFileSync(yamlPath, "", "utf8");
      expect(findTeamFile(dir)).toBe(yamlPath);
    } finally {
      cleanup();
    }
  });

  it("prefers team.yaml when both exist", () => {
    dir = mkdtempSync(join(tmpdir(), "agvsr-find-team-"));
    try {
      const yamlPath = join(dir, "team.yaml");
      writeFileSync(yamlPath, "", "utf8");
      writeFileSync(join(dir, "team.toml"), "", "utf8");
      expect(findTeamFile(dir)).toBe(yamlPath);
    } finally {
      cleanup();
    }
  });
});

describe("allowedTargets (star topology, D10)", () => {
  const team = parseTeam(VALID);

  it("lets the supervisor reach every worker plus the human", () => {
    expect(allowedTargets(team, "supervisor").sort()).toEqual(
      ["design", "implementation", "qa", "user"].sort(),
    );
  });

  it("restricts workers to the supervisor only", () => {
    expect(allowedTargets(team, "implementation")).toEqual(["supervisor"]);
    expect(allowedTargets(team, "qa")).toEqual(["supervisor"]);
  });
});
