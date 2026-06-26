import { describe, expect, it } from "bun:test";
import { allowedTargets, parseTeam, TeamConfigError } from "../src/config/team.ts";

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
    expect(team.roles.qa!.instances).toBe(1); // default
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
