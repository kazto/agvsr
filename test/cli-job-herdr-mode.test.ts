import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import type { Job } from "../src/protocol.ts";

// Cold `bun run` subprocess starts can push this past Bun's default 5s timeout.
setDefaultTimeout(20000);

const CLI_PATH = join(process.cwd(), "src/cli/agvsr.ts");

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@test.test"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "hello");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

interface Harness {
  base: string;
  repo: string;
  worktrees: string;
  sock: string;
  db: string;
  daemon: Daemon;
  client: Client;
  resolveCalls: Array<{ workspaceId: string; session?: string | null }>;
  oldWorktreesEnv: string | undefined;
}

async function setupHarness(): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "agvsr-cli-herdr-mode-"));
  const repo = makeRepo(base);
  const worktrees = join(base, "worktrees");
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");

  const oldWorktreesEnv = process.env.AGVSR_WORKTREES;
  mkdirSync(worktrees, { recursive: true });
  process.env.AGVSR_WORKTREES = worktrees;

  const resolveCalls: Array<{ workspaceId: string; session?: string | null }> = [];
  const herdrClient: HerdrClient = {
    async resolveWorkspaceName(workspaceId, session) {
      resolveCalls.push({ workspaceId, session });
      return "agvsr";
    },
    async promptAgent() {},
    async listAgents() {
      return { ok: true, agents: [] };
    },
    async promptAgentChecked() {
      return { ok: true };
    },
  };

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team: TEAM,
    interruptRunningJobsOnStart: false,
    herdrClient,
    turnRunner: async (dispatch: TurnDispatch) => ({
      events: [],
      outcome: { sessionId: `${dispatch.role}-s`, finalText: "", exitCode: 0 },
    }),
  });

  const client = await Client.connect(sock);
  return { base, repo, worktrees, sock, db, daemon, client, resolveCalls, oldWorktreesEnv };
}

async function teardown(h: Harness): Promise<void> {
  h.client.close();
  await h.daemon.close();
  if (h.oldWorktreesEnv === undefined) delete process.env.AGVSR_WORKTREES;
  else process.env.AGVSR_WORKTREES = h.oldWorktreesEnv;
  rmSync(h.base, { recursive: true, force: true });
}

/** Runs the real `agvsr job "..."` CLI as a subprocess with a controlled env —
 * explicitly stripping any HERDR_* the actual test-runner shell may itself have
 * (this suite can run inside a real herdr pane) so each case's mode is deterministic. */
async function runJobCli(
  h: Harness,
  goal: string,
  herdrEnv: Record<string, string> | null,
): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "HERDR_SESSION"]) {
    delete env[key];
  }
  Object.assign(env, {
    AGVSR_SOCK: h.sock,
    AGVSR_STORE: h.db,
    AGVSR_WORKTREES: h.worktrees,
    ...herdrEnv,
  });

  const proc = Bun.spawn(["bun", "run", CLI_PATH, "job", goal], {
    cwd: h.repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

describe("agvsr job herdr mode detection (D29)", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) await teardown(harness);
    harness = null;
  });

  it("submits standalone (all herdr fields null) when HERDR_ENV/HERDR_WORKSPACE_ID are unset", async () => {
    harness = await setupHarness();
    const { code, out, err } = await runJobCli(harness, "standalone job", null);
    expect(err).toBe("");
    expect(code).toBe(0);
    const outputLines = out.trim().split("\n");
    expect(outputLines[0]).toMatch(/^submitting job [0-9a-f-]{36}$/);
    const submittedId = outputLines[0]!.slice("submitting job ".length);
    expect(outputLines[1]).toBe(`job ${submittedId} created (running)`);

    const jobs = await harness.client.request<{ jobs: Job[] }>("job.list");
    expect(jobs.ok).toBe(true);
    const job = jobs.ok ? jobs.result.jobs.find((j) => j.goal === "standalone job") : undefined;
    expect(job).toBeTruthy();
    expect(job?.workspace_id).toBeNull();
    expect(job?.caller_pane_id).toBeNull();
    expect(harness.resolveCalls).toEqual([]);
  });

  it("submits herdr mode fields when HERDR_ENV=1 and HERDR_WORKSPACE_ID are set", async () => {
    harness = await setupHarness();
    const { code, err } = await runJobCli(harness, "herdr mode job", {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SESSION: "work",
    });
    expect(err).toBe("");
    expect(code).toBe(0);

    const jobs = await harness.client.request<{ jobs: Job[] }>("job.list");
    expect(jobs.ok).toBe(true);
    const job = jobs.ok ? jobs.result.jobs.find((j) => j.goal === "herdr mode job") : undefined;
    expect(job).toBeTruthy();
    expect(job?.workspace_id).toBe("w1");
    expect(job?.workspace_name).toBe("agvsr");
    expect(job?.caller_pane_id).toBe("w1:p1");
    expect(job?.herdr_session).toBe("work");
    expect(harness.resolveCalls).toEqual([{ workspaceId: "w1", session: "work" }]);
  });

  it("does not require HERDR_PANE_ID/HERDR_SESSION — only HERDR_ENV and HERDR_WORKSPACE_ID gate the mode", async () => {
    harness = await setupHarness();
    const { code, err } = await runJobCli(harness, "partial herdr env job", {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w2",
    });
    expect(err).toBe("");
    expect(code).toBe(0);

    const jobs = await harness.client.request<{ jobs: Job[] }>("job.list");
    expect(jobs.ok).toBe(true);
    const job = jobs.ok
      ? jobs.result.jobs.find((j) => j.goal === "partial herdr env job")
      : undefined;
    expect(job?.workspace_id).toBe("w2");
    expect(job?.caller_pane_id).toBeNull();
    expect(job?.herdr_session).toBeNull();
  });
});
