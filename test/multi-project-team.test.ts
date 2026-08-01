import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

// One daemon serves every project on the machine, but each job's target repo
// may carry its own team.yaml (written by `agvsr init`). These tests confirm
// job.create resolves that project's own config instead of always inheriting
// whatever team.yaml happened to be loaded when the daemon started — the fix
// for the "silently runs a job under a different project's roles/adapters/
// models" footgun.

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function makeRepo(base: string, name: string): string {
  const repo = join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "hello");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

const GLOBAL_TEAM_YAML = `
roles:
  supervisor: { adapter: claude-code, model: global-default-model }
`;

const PROJECT_TEAM_YAML = `
roles:
  supervisor: { adapter: codex, model: project-specific-model }
`;

const PROJECT_TEAM_TOML = `
[roles.supervisor]
adapter = "codex"
model = "project-specific-model"
`;

interface Harness {
  base: string;
  daemon: Daemon;
  client: Client;
  dispatches: TurnDispatch[];
  oldWorktreesEnv: string | undefined;
}

async function setupHarness(): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "agvsr-multi-project-"));
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");
  const worktrees = join(base, "worktrees");
  mkdirSync(worktrees, { recursive: true });

  const dispatches: TurnDispatch[] = [];
  // provisionWorktree() reads AGVSR_WORKTREES at job.create time (not just at
  // daemon startup), so this must stay set for the harness's whole lifetime —
  // restoring it right after startDaemon() would leak job worktrees into the
  // real ~/.config/agvsr/worktrees the moment a test calls job.create.
  const oldWorktreesEnv = process.env.AGVSR_WORKTREES;
  process.env.AGVSR_WORKTREES = worktrees;

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: parseTeam(GLOBAL_TEAM_YAML),
    interruptRunningJobsOnStart: false,
    turnRunner: async (dispatch) => {
      dispatches.push(dispatch);
      return {
        events: [{ kind: "result", ok: true, text: dispatch.role }],
        outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
      };
    },
  });

  const client = await Client.connect(sock);
  return { base, daemon, client, dispatches, oldWorktreesEnv };
}

async function teardown(h: Harness): Promise<void> {
  h.client.close();
  await h.daemon.close();
  if (h.oldWorktreesEnv === undefined) delete process.env.AGVSR_WORKTREES;
  else process.env.AGVSR_WORKTREES = h.oldWorktreesEnv;
  rmSync(h.base, { recursive: true, force: true });
}

async function waitForDispatch(dispatches: TurnDispatch[], before: number): Promise<TurnDispatch> {
  for (let i = 0; i < 200; i++) {
    if (dispatches.length > before) return dispatches[before]!;
    await Bun.sleep(5);
  }
  throw new Error("expected a dispatch, got none");
}

describe("per-job team resolution across projects", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await teardown(harness);
    harness = null;
  });

  it("uses the job's own project team.yaml instead of the daemon's global default", async () => {
    harness = await setupHarness();
    const projectRepo = makeRepo(harness.base, "project-with-own-team");
    writeFileSync(join(projectRepo, "team.yaml"), PROJECT_TEAM_YAML, "utf8");

    const before = harness.dispatches.length;
    const created = await harness.client.request<{ job: Job }>("job.create", {
      goal: "use my own team.yaml",
      cwd: projectRepo,
    });
    expect(created.ok).toBe(true);

    const dispatch = await waitForDispatch(harness.dispatches, before);
    expect(dispatch.adapter).toBe("codex");
    expect(dispatch.model).toBe("project-specific-model");
  });

  it("uses the job's own project team.toml when no team.yaml is present", async () => {
    harness = await setupHarness();
    const projectRepo = makeRepo(harness.base, "project-with-own-team-toml");
    writeFileSync(join(projectRepo, "team.toml"), PROJECT_TEAM_TOML, "utf8");

    const before = harness.dispatches.length;
    const created = await harness.client.request<{ job: Job }>("job.create", {
      goal: "use my own team.toml",
      cwd: projectRepo,
    });
    expect(created.ok).toBe(true);

    const dispatch = await waitForDispatch(harness.dispatches, before);
    expect(dispatch.adapter).toBe("codex");
    expect(dispatch.model).toBe("project-specific-model");
  });

  it("prefers team.yaml over team.toml when both exist in the job's cwd", async () => {
    harness = await setupHarness();
    const projectRepo = makeRepo(harness.base, "project-with-both-team-files");
    writeFileSync(join(projectRepo, "team.yaml"), PROJECT_TEAM_YAML, "utf8");
    writeFileSync(
      join(projectRepo, "team.toml"),
      `\n[roles.supervisor]\nadapter = "agy"\nmodel = "toml-should-be-ignored"\n`,
      "utf8",
    );

    const before = harness.dispatches.length;
    const created = await harness.client.request<{ job: Job }>("job.create", {
      goal: "yaml wins",
      cwd: projectRepo,
    });
    expect(created.ok).toBe(true);

    const dispatch = await waitForDispatch(harness.dispatches, before);
    expect(dispatch.adapter).toBe("codex");
    expect(dispatch.model).toBe("project-specific-model");
  });

  it("falls back to the daemon's global team when the job's cwd has no team.yaml", async () => {
    harness = await setupHarness();
    const plainRepo = makeRepo(harness.base, "project-without-own-team");

    const before = harness.dispatches.length;
    const created = await harness.client.request<{ job: Job }>("job.create", {
      goal: "use the global default",
      cwd: plainRepo,
    });
    expect(created.ok).toBe(true);

    const dispatch = await waitForDispatch(harness.dispatches, before);
    expect(dispatch.adapter).toBe("claude-code");
    expect(dispatch.model).toBe("global-default-model");
  });

  it("rejects job creation with invalid_team when the job's own team.yaml is malformed", async () => {
    harness = await setupHarness();
    const brokenRepo = makeRepo(harness.base, "project-with-broken-team");
    writeFileSync(brokenRepo + "/team.yaml", "roles:\n  not_a_supervisor: { adapter: codex }\n");

    const before = harness.dispatches.length;
    const created = await harness.client.request<{ job: Job }>("job.create", {
      goal: "should be rejected",
      cwd: brokenRepo,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("invalid_team");
      expect(created.error.message).toContain(brokenRepo);
    }
    // No turn dispatched, and no partial job left behind.
    expect(harness.dispatches.length).toBe(before);
    const list = await harness.client.request<{ jobs: Job[] }>("job.list");
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.result.jobs.some((j) => j.cwd === brokenRepo)).toBe(false);
    }
  });

  it("keeps a job's own project team frozen across agvsr reload of the global team", async () => {
    // `reload` re-reads the daemon's fixed startup teamFile path (it ignores
    // any request params), so this test needs a real file on disk rather than
    // an in-memory `team`, unlike the other tests in this file.
    const base = mkdtempSync(join(tmpdir(), "agvsr-multi-project-reload-"));
    const sock = join(base, "daemon.sock");
    const db = join(base, "store.sqlite");
    const worktrees = join(base, "worktrees");
    const globalTeamFile = join(base, "team.yaml");
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(globalTeamFile, GLOBAL_TEAM_YAML, "utf8");

    const dispatches: TurnDispatch[] = [];
    const oldWorktreesEnv = process.env.AGVSR_WORKTREES;
    process.env.AGVSR_WORKTREES = worktrees;
    const { startDaemon } = await import("../src/daemon/daemon.ts");
    const daemon = await startDaemon({
      endpoint: sock,
      storeFile: db,
      teamFile: globalTeamFile,
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        dispatches.push(dispatch);
        return {
          events: [{ kind: "result", ok: true, text: dispatch.role }],
          outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
        };
      },
    });

    const client = await Client.connect(sock);
    try {
      const projectRepo = makeRepo(base, "project-frozen-across-reload");
      writeFileSync(join(projectRepo, "team.yaml"), PROJECT_TEAM_YAML, "utf8");

      const before = dispatches.length;
      const created = await client.request<{ job: Job }>("job.create", {
        goal: "freeze my config",
        cwd: projectRepo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error();
      await waitForDispatch(dispatches, before);

      // Overwrite the daemon's global team file with something else entirely,
      // then reload — this only affects the global default, never jobs that
      // already froze their own project's team.yaml at creation.
      writeFileSync(
        globalTeamFile,
        `
roles:
  supervisor: { adapter: agy, model: reloaded-model }
`,
        "utf8",
      );
      const reloaded = await client.request("reload");
      expect(reloaded.ok).toBe(true);

      const beforeSecond = dispatches.length;
      const told = await client.request("job.tell", {
        job_id: created.result.job.id,
        body: "still frozen?",
      });
      expect(told.ok).toBe(true);
      const dispatch = await waitForDispatch(dispatches, beforeSecond);
      expect(dispatch.adapter).toBe("codex");
      expect(dispatch.model).toBe("project-specific-model");
    } finally {
      client.close();
      await daemon.close();
      if (oldWorktreesEnv === undefined) delete process.env.AGVSR_WORKTREES;
      else process.env.AGVSR_WORKTREES = oldWorktreesEnv;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
