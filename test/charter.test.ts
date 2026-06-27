import { describe, expect, it } from "bun:test";
import { composeCharter, fillScaffold } from "../src/adapters/charter.ts";
import { parseTeam } from "../src/config/team.ts";

const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  qa: { adapter: agy, model: m }
`);

describe("fillScaffold", () => {
  const scaffold =
    "role={{role}} job={{job_id}} cwd={{cwd}} branch={{branch}} targets={{allowed_targets}}\n[{{completion_tools}}]";

  it("substitutes placeholders including branch", () => {
    const out = fillScaffold(scaffold, {
      role: "qa",
      jobId: "J1",
      cwd: "/w",
      branch: "agvsr/abc12345",
      allowedTargets: ["supervisor"],
    });
    expect(out).toContain("role=qa job=J1 cwd=/w branch=agvsr/abc12345 targets=supervisor");
  });

  it("uses '(not set)' when branch is absent", () => {
    const out = fillScaffold(scaffold, {
      role: "qa",
      jobId: "J",
      cwd: "/w",
      allowedTargets: ["supervisor"],
    });
    expect(out).toContain("branch=(not set)");
  });

  it("injects completion tools only for the supervisor", () => {
    const worker = fillScaffold(scaffold, {
      role: "qa",
      jobId: "J",
      cwd: "/w",
      allowedTargets: ["supervisor"],
    });
    expect(worker).toContain("[]"); // empty completion block

    const sup = fillScaffold(scaffold, {
      role: "supervisor",
      jobId: "J",
      cwd: "/w",
      allowedTargets: ["qa", "user"],
    });
    expect(sup).toContain("agvsr_complete");
    expect(sup).toContain("agvsr_fail");
  });
});

describe("composeCharter (bundled charters)", () => {
  it("composes scaffold + role charter with context filled", () => {
    const prompt = composeCharter(team, "qa", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    expect(prompt).toContain("agvsr Operating Protocol"); // scaffold layer
    expect(prompt).toContain("Role: qa"); // role charter layer
    expect(prompt).toContain("/work/repo"); // cwd substituted
    expect(prompt).toContain("agvsr/deadbeef"); // branch substituted
    expect(prompt).toContain("to: supervisor"); // qa's only allowed target (D10)
    expect(prompt).not.toContain("{{"); // no leftover placeholders
  });

  it("gives the supervisor completion tools and worker targets", () => {
    const prompt = composeCharter(team, "supervisor", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    expect(prompt).toContain("agvsr_complete");
    expect(prompt).toContain("Role: supervisor");
  });
});
