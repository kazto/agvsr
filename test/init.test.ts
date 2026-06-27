import { describe, expect, it } from "bun:test";
import { buildTeamYaml, resolveRoleSpecs, DEFAULT_ROLES, InitError } from "../src/config/init.ts";
import { parseTeam } from "../src/config/team.ts";

function defaults() {
  return resolveRoleSpecs({
    roleNames: [...DEFAULT_ROLES],
    defaultAdapter: "claude-code",
    roleOverrides: new Map(),
  });
}

describe("buildTeamYaml", () => {
  it("defaults: valid team with 4 roles, supervisor first", () => {
    const yaml = buildTeamYaml({ roles: defaults(), comments: true });
    const team = parseTeam(yaml);
    const roleKeys = Object.keys(team.roles);
    expect(roleKeys[0]).toBe("supervisor");
    expect(roleKeys).toHaveLength(4);
    expect(team.roles.supervisor).toBeDefined();
  });

  it("--no-comments: header-free doc still parses", () => {
    const yaml = buildTeamYaml({ roles: defaults(), comments: false });
    expect(yaml).not.toContain("# Generated");
    expect(yaml).not.toContain("# hooks");
    const team = parseTeam(yaml);
    expect(team.roles.supervisor).toBeDefined();
  });

  it("supervisor is moved first regardless of input order", () => {
    const reversed = [...defaults()].reverse(); // qa, implementation, design, supervisor
    const yaml = buildTeamYaml({ roles: reversed, comments: false });
    const lines = yaml.split("\n");
    const roleEntryLines = lines.filter((l) => /^  \w/.test(l) && l.endsWith(":"));
    expect(roleEntryLines[0]).toBe("  supervisor:");
  });

  it("--role overrides adapter and model for specific role", () => {
    const overrides = new Map([["design", { adapter: "codex" as const, model: "gpt-5.5" }]]);
    const roles = resolveRoleSpecs({
      roleNames: [...DEFAULT_ROLES],
      defaultAdapter: "claude-code",
      roleOverrides: overrides,
    });
    const yaml = buildTeamYaml({ roles, comments: false });
    const team = parseTeam(yaml);
    expect(team.roles.design?.adapter).toBe("codex");
    expect(team.roles.design?.model).toBe("gpt-5.5");
    expect(team.roles.supervisor?.adapter).toBe("claude-code");
  });

  it("--model overrides default model for all roles", () => {
    const roles = resolveRoleSpecs({
      roleNames: [...DEFAULT_ROLES],
      defaultAdapter: "claude-code",
      defaultModel: "claude-haiku-4-5",
      roleOverrides: new Map(),
    });
    for (const r of roles) {
      expect(r.model).toBe("claude-haiku-4-5");
    }
  });

  it("per-role model > --model > built-in default", () => {
    const overrides = new Map([["design", { adapter: "codex" as const, model: "gpt-override" }]]);
    const roles = resolveRoleSpecs({
      roleNames: [...DEFAULT_ROLES],
      defaultAdapter: "claude-code",
      defaultModel: "global-model",
      roleOverrides: overrides,
    });
    expect(roles.find((r) => r.role === "design")?.model).toBe("gpt-override");
    expect(roles.find((r) => r.role === "supervisor")?.model).toBe("global-model");
  });

  it("throws InitError for unknown adapter", () => {
    const roles = [{ role: "supervisor", adapter: "unknown-ai" as "claude-code", model: "m1" }];
    expect(() => buildTeamYaml({ roles, comments: false })).toThrow(InitError);
  });

  it("throws InitError for empty model", () => {
    const roles = [{ role: "supervisor", adapter: "claude-code" as const, model: "" }];
    expect(() => buildTeamYaml({ roles, comments: false })).toThrow(InitError);
  });

  it("throws InitError for whitespace-only model", () => {
    const roles = [{ role: "supervisor", adapter: "claude-code" as const, model: "   " }];
    expect(() => buildTeamYaml({ roles, comments: false })).toThrow(InitError);
  });

  it("non-bundled charter role emits TODO comment and valid file", () => {
    const roles = [
      { role: "supervisor", adapter: "claude-code" as const, model: "m" },
      { role: "custom-role", adapter: "claude-code" as const, model: "m" },
    ];
    const yaml = buildTeamYaml({ roles, comments: true });
    expect(yaml).toContain("TODO");
    expect(yaml).toContain("custom-role");
    const team = parseTeam(yaml);
    expect(team.roles["custom-role"]).toBeDefined();
  });

  it("non-bundled charter role TODO comment absent in --no-comments mode", () => {
    const roles = [
      { role: "supervisor", adapter: "claude-code" as const, model: "m" },
      { role: "custom-role", adapter: "claude-code" as const, model: "m" },
    ];
    const yaml = buildTeamYaml({ roles, comments: false });
    expect(yaml).not.toContain("TODO");
    const team = parseTeam(yaml);
    expect(team.roles["custom-role"]).toBeDefined();
  });

  it("output ends with a single newline", () => {
    const yaml = buildTeamYaml({ roles: defaults(), comments: false });
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
  });

  it("snapshot: default --no-comments output is stable", () => {
    const yaml = buildTeamYaml({ roles: defaults(), comments: false });
    expect(yaml).toBe(
      "roles:\n" +
        "  supervisor:\n" +
        "    adapter: claude-code\n" +
        "    model: claude-opus-4-8\n" +
        "  design:\n" +
        "    adapter: claude-code\n" +
        "    model: claude-opus-4-8\n" +
        "  implementation:\n" +
        "    adapter: claude-code\n" +
        "    model: claude-opus-4-8\n" +
        "  qa:\n" +
        "    adapter: claude-code\n" +
        "    model: claude-opus-4-8\n",
    );
  });
});
