/**
 * Daemon-executed verification gate (D43 mechanism B).
 *
 * The gate's whole claim is that the agent's report is not an input, so the
 * tests drive it through real commands whose output the daemon has to read.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam, type TeamConfig } from "../src/config/team.ts";
import { extractCount, runVerify } from "../src/git/verify.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

function git(cwd: string, args: string[]): void {
  spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const trash: string[] = [];
let openDaemon: Daemon | null = null;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(async () => {
  if (openDaemon) {
    await openDaemon.close();
    openDaemon = null;
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const p of trash.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

describe("extractCount", () => {
  it("reads bun test's summary", () => {
    expect(extractCount("\n 12 pass\n 0 fail\nRan 525 tests across 46 files.\n")).toBe(525);
  });

  it("reads vitest's summary", () => {
    expect(extractCount("      Tests  2 failed | 291 passed (293)\n")).toBe(293);
  });

  it("reads jest's summary", () => {
    expect(extractCount("Tests:       1 failed, 292 passed, 293 total\n")).toBe(293);
  });

  it("honours a custom pattern over the built-ins", () => {
    expect(extractCount("checks completed: 77\n", "completed:\\s*(\\d+)")).toBe(77);
  });

  it("returns null rather than guessing", () => {
    expect(extractCount("everything is fine!\n")).toBeNull();
  });
});

describe("runVerify", () => {
  it("merges stderr into the output it reads", () => {
    const dir = join(tmpdir(), `agvsr-verify-${randomUUID()}`);
    trash.push(dir);
    mkdirSync(dir, { recursive: true });
    // Runners disagree about which stream carries the summary; codex printed a
    // fatal error to stdout while stderr stayed empty, which is how one job
    // failed with no diagnosis at all.
    const run = runVerify({ command: "echo out; echo err 1>&2" }, dir, {});
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("out");
    expect(run.output).toContain("err");
  });

  it("passes the supplied environment through", () => {
    const dir = join(tmpdir(), `agvsr-verify-${randomUUID()}`);
    trash.push(dir);
    mkdirSync(dir, { recursive: true });
    const run = runVerify({ command: "echo $MARKER" }, dir, { MARKER: "present" });
    expect(run.output).toContain("present");
  });
});

/**
 * A repo whose "test suite" is a script reporting a count that depends on
 * $SUITE_SIZE — the shape of a vitest project excluded by a missing env var.
 */
async function setup(teamYaml: string, opts: { sizeInWorktree?: string } = {}) {
  const base = join(tmpdir(), `agvsr-verifygate-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "T"]);
  const runner = join(repo, "run-tests.sh");
  writeFileSync(
    runner,
    `#!/bin/sh\nN=\${SUITE_SIZE:-${opts.sizeInWorktree ?? "10"}}\necho "Ran $N tests across 1 files."\nexit 0\n`,
  );
  chmodSync(runner, 0o755);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);

  setEnv("AGVSR_WORKTREES", join(base, "worktrees"));
  setEnv("AGVSR_SEED_PATHS", "off");

  const team: TeamConfig = parseTeam(teamYaml);
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const sock = join(base, "d.sock");
  openDaemon = await startDaemon({
    endpoint: sock,
    storeFile: join(base, "d.sqlite"),
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d) => ({
      events: [{ kind: "result", ok: true, text: d.role }],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }),
  });

  const c = await Client.connect(sock);
  const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
  if (!created.ok) throw new Error(`job.create failed: ${created.error.message}`);
  return { c, repo, job: created.result.job };
}

const TEAM_HEAD = `
roles:
  supervisor: { adapter: claude-code, model: m }
`;

describe("verification gate at job.complete (D43)", () => {
  it("refuses completion when fewer tests ran than the baseline", async () => {
    // The baseline is stated outright so the test does not depend on the
    // checkout and the worktree diverging by accident.
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "./run-tests.sh"
  baseline: "fixed:530"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "all green" });

    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.error.code).toBe("verify_regressed");
      expect(done.error.message).toContain("10 vs 530");
      expect(done.error.message).toContain("520 test(s) did not run");
      // The likely cause is named, since that is what the human has to fix.
      expect(done.error.message).toContain("worktree.env_files");
    }
    c.close();
  });

  it("leaves the job running when it refuses", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "./run-tests.sh"
  baseline: "fixed:530"
`);
    await c.request("job.complete", { job_id: job.id, result: "all green" });
    const got = await c.request<{ job: Job }>("job.get", { id: job.id });
    expect(got.ok && got.result.job.status).toBe("running");
    c.close();
  });

  it("allows completion when the full suite ran", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "./run-tests.sh"
  baseline: "fixed:10"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "all green" });
    expect(done.ok).toBe(true);
    c.close();
  });

  it("accepts a shortfall within tolerance", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "./run-tests.sh"
  baseline: "fixed:12"
  tolerance: 2
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(true);
    c.close();
  });

  it("refuses a failing command regardless of counts", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "echo 'Ran 999 tests across 1 files.'; exit 1"
  baseline: "fixed:1"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe("verify_failed");
    c.close();
  });

  it("refuses when the summary cannot be read — silence is not success", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "echo 'everything is fine'"
  baseline: "fixed:10"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.error.code).toBe("verify_unreadable");
      expect(done.error.message).toContain("count_pattern");
    }
    c.close();
  });

  it("checks only the exit code when baseline is off", async () => {
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "echo 'everything is fine'"
  baseline: "off"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(true);
    c.close();
  });

  it("measures the baseline from the checkout, where the env files are", async () => {
    // The worktree runs 10; the checkout runs 40 because the daemon passes the
    // team env to both — this is the recorded 293-vs-530 failure in miniature.
    const { c, job } = await setup(`${TEAM_HEAD}
env:
  SUITE_SIZE: "40"
verify:
  command: "./run-tests.sh"
`);
    // Pinning the worktree's runner to 10 makes the two diverge. It is committed
    // because the commit gate runs first — verification judges committed work.
    const worktreeRunner = join(job.worktree!, "run-tests.sh");
    writeFileSync(worktreeRunner, `#!/bin/sh\necho "Ran 10 tests across 1 files."\nexit 0\n`);
    chmodSync(worktreeRunner, 0o755);
    git(job.worktree!, ["add", "-A"]);
    git(job.worktree!, ["commit", "-m", "narrow the suite"]);

    const done = await c.request("job.complete", { job_id: job.id, result: "all green" });
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.error.code).toBe("verify_regressed");
      expect(done.error.message).toContain("10 vs 40");
    }
    c.close();
  });

  it("does nothing for a team with no verify block", async () => {
    const { c, job } = await setup(TEAM_HEAD);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(true);
    c.close();
  });

  it("stands down when AGVSR_VERIFY_GATE is disabled", async () => {
    setEnv("AGVSR_VERIFY_GATE", "0");
    const { c, job } = await setup(`${TEAM_HEAD}
verify:
  command: "./run-tests.sh"
  baseline: "fixed:530"
`);
    const done = await c.request("job.complete", { job_id: job.id, result: "ok" });
    expect(done.ok).toBe(true);
    c.close();
  });
});
