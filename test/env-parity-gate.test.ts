/**
 * The environment-parity gate at job.create (D43).
 *
 * Real git repos throughout: the whole guarantee rests on what `git` reports as
 * ignored, so mocking that away would test nothing worth testing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam, type TeamConfig } from "../src/config/team.ts";
import type { Daemon, TurnDispatch } from "../src/daemon/daemon.ts";
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

/** A repo holding an ignored `.env`, plus a daemon pointed at scratch dirs. */
async function setup(team: TeamConfig, dispatches: TurnDispatch[] = []) {
  const base = join(tmpdir(), `agvsr-parity-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  writeFileSync(join(repo, ".env"), "DATABASE_TEST_URL=postgres://localhost/test\nFLAG=api\n");

  setEnv("AGVSR_WORKTREES", join(base, "worktrees"));
  setEnv("AGVSR_SEED_PATHS", "off");

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const sock = join(base, "d.sock");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: join(base, "d.sqlite"),
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d) => {
      dispatches.push(d);
      return {
        events: [{ kind: "result", ok: true, text: d.role }],
        outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
      };
    },
  });
  openDaemon = daemon;
  return { repo, sock };
}

const teamWith = (yaml: string) =>
  parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  implementation: { adapter: codex, model: m }
${yaml}
`);

describe("environment parity gate (D43)", () => {
  it("refuses job.create while an ignored env file is undeclared", async () => {
    const { repo, sock } = await setup(teamWith(""));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("env_parity_required");
      expect(created.error.message).toContain(".env");
      // The message has to carry the fix, not just the complaint.
      expect(created.error.message).toContain("worktree:");
      expect(created.error.message).toContain("env_files:");
    }
    c.close();
  });

  it("creates no job row when it refuses", async () => {
    const { repo, sock } = await setup(teamWith(""));
    const c = await Client.connect(sock);
    await c.request("job.create", { goal: "g", cwd: repo });

    const listed = await c.request<{ jobs: Job[] }>("job.list", {});
    expect(listed.ok && listed.result.jobs.length).toBe(0);
    c.close();
  });

  it("allows job.create once every env file is declared", async () => {
    const { repo, sock } = await setup(
      teamWith(`
worktree:
  env_files:
    ".env": ignore
`),
    );
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    expect(created.ok).toBe(true);
    c.close();
  });

  it("passes declared variables into the role turn, below team env", async () => {
    const dispatches: TurnDispatch[] = [];
    const { repo, sock } = await setup(
      teamWith(`
env:
  FLAG: from-team
worktree:
  env_files:
    ".env": env
`),
      dispatches,
    );
    const c = await Client.connect(sock);
    await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    for (let i = 0; i < 200 && dispatches.length === 0; i++) await Bun.sleep(10);

    expect(dispatches.length).toBeGreaterThan(0);
    // The file supplies what the config does not...
    expect(dispatches[0]!.env.DATABASE_TEST_URL).toBe("postgres://localhost/test");
    // ...and an explicit team.yaml value outranks the file's.
    expect(dispatches[0]!.env.FLAG).toBe("from-team");
    c.close();
  });

  it("passes only the named keys for a key-list declaration", async () => {
    const dispatches: TurnDispatch[] = [];
    const { repo, sock } = await setup(
      teamWith(`
worktree:
  env_files:
    ".env": [DATABASE_TEST_URL]
`),
      dispatches,
    );
    const c = await Client.connect(sock);
    await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    for (let i = 0; i < 200 && dispatches.length === 0; i++) await Bun.sleep(10);

    expect(dispatches[0]!.env.DATABASE_TEST_URL).toBe("postgres://localhost/test");
    // FLAG=api was in the same file; leaving it out is the point of a key list.
    expect(dispatches[0]!.env.FLAG).toBeUndefined();
    c.close();
  });

  it("places a copy-declared file into the job worktree", async () => {
    const { repo, sock } = await setup(
      teamWith(`
worktree:
  env_files:
    ".env": copy
`),
    );
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    expect(created.ok).toBe(true);
    const worktree = created.ok ? created.result.job.worktree! : "";
    expect(existsSync(join(worktree, ".env"))).toBe(true);
    c.close();
  });

  it("stands down when AGVSR_ENV_PARITY is disabled", async () => {
    setEnv("AGVSR_ENV_PARITY", "0");
    const { repo, sock } = await setup(teamWith(""));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: repo });
    expect(created.ok).toBe(true);
    c.close();
  });

  it("does not engage for a non-git cwd", async () => {
    const { sock } = await setup(teamWith(""));
    const plain = join(tmpdir(), `agvsr-parity-plain-${randomUUID()}`);
    trash.push(plain);
    mkdirSync(plain, { recursive: true });

    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "g", cwd: plain });
    expect(created.ok).toBe(true);
    c.close();
  });
});
