import { describe, expect, it } from "bun:test";
import { composeCharter, fillScaffold } from "../src/adapters/charter.ts";
import { parseTeam } from "../src/config/team.ts";

const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  implementation: { adapter: codex, model: m }
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

  it("renders the shared-workspace note by default", () => {
    const out = fillScaffold("note: {{workspace_note}}", {
      role: "implementation",
      jobId: "J1",
      cwd: "/w",
      allowedTargets: ["supervisor"],
    });
    expect(out).toContain("All roles operate on the same working tree at `/w`");
  });

  it("renders the isolated-workspace note when isolatedWorktree is true", () => {
    const out = fillScaffold("note: {{workspace_note}}", {
      role: "implementation-1",
      jobId: "J1",
      cwd: "/w-instance-1",
      branch: "agvsr/J1--implementation-1",
      allowedTargets: ["supervisor"],
      isolatedWorktree: true,
    });
    expect(out).toContain("your own dedicated working tree at `/w-instance-1`");
    expect(out).toContain("agvsr/J1--implementation-1");
    expect(out).not.toContain("{{");
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
  it("composes scaffold + role charter with the hardened communication rules", () => {
    const prompt = composeCharter(team, "qa", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    const normalized = prompt.replace(/\s+/g, " ");
    expect(prompt).toContain("agvsr Operating Protocol"); // scaffold layer
    expect(prompt).toContain("Role: qa"); // role charter layer
    expect(prompt).toContain("/work/repo"); // cwd substituted
    expect(prompt).toContain("agvsr/deadbeef"); // branch substituted
    expect(prompt).toContain("to: supervisor"); // qa's only allowed target (D10)
    expect(normalized).toContain("Information only moves when you call an agvsr MCP tool");
    expect(normalized).toContain("direct MCP tool call");
    expect(normalized).toContain("not a shell command");
    expect(normalized).toContain("running `agvsr send ...` in a shell delivers nothing");
    expect(normalized).toContain("agvsr_send");
    expect(normalized).toContain("MCP tools already available in the current turn");
    expect(normalized).toContain("agvsr ...");
    expect(normalized).toContain("agmsg ...");
    expect(normalized).toContain("silently discarded");
    expect(normalized).toContain("The only valid send path is MCP tool invocation");
    expect(normalized).toContain("agvsr_request_review");
    expect(normalized).toContain("Never choose a reviewer yourself");
    expect(normalized).toContain("never run `herdr agent prompt`");
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

  it("requires the supervisor to state non-goals when delegating", () => {
    const prompt = composeCharter(team, "supervisor", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    const normalized = prompt.replace(/\s+/g, " ");
    expect(normalized).toContain("including its non-goals");
    expect(normalized).toContain("out of scope");
    expect(normalized).toContain("without human approval");
    expect(normalized).toContain("smallest mechanism");
  });

  it("requires human design approval before implementation", () => {
    const prompt = composeCharter(team, "supervisor", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    const normalized = prompt.replace(/\s+/g, " ");
    expect(normalized).toContain("design human-approved before implementation");
    expect(normalized).toContain("approval_required");
    expect(normalized).toContain("If they ask for changes, route back to");
  });

  it("requires committed work before completion in the role charters", () => {
    const supervisor = composeCharter(team, "supervisor", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    }).replace(/\s+/g, " ");
    expect(supervisor).toContain("Require a committed handoff");
    expect(supervisor).toContain("Do not accept completion until the work is committed on");

    const implementation = composeCharter(team, "implementation", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    }).replace(/\s+/g, " ");
    expect(implementation).toContain("Complete only after committing the work");
    expect(implementation).toContain("Uncommitted work can be lost");
  });

  it("resolves an array-expanded implementation instance's bundled charter via charter_role", () => {
    const multiTeam = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  implementation:
    - { adapter: codex, model: m }
    - { adapter: claude-code, model: m }
`);
    const prompt = composeCharter(multiTeam, "implementation-1", {
      jobId: "JOB-7",
      cwd: "/work/instance-1",
      branch: "agvsr/deadbeef--implementation-1",
      isolatedWorktree: true,
    });
    expect(prompt).toContain("Role: implementation"); // bundled implementation.md, not implementation-1.md
    expect(prompt).toContain("your own dedicated working tree");
    expect(prompt).not.toContain("{{");
  });

  it("tells qa that mocking the core is not validation", () => {
    const prompt = composeCharter(team, "qa", {
      jobId: "JOB-7",
      cwd: "/work/repo",
      branch: "agvsr/deadbeef",
    });
    const normalized = prompt.replace(/\s+/g, " ");
    expect(normalized).toContain("Mocking the core is not validation");
    expect(normalized).toContain("real smoke");
    expect(normalized).toContain("State what is not covered");
  });
});
