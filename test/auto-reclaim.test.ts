/**
 * Automatic worktree reclamation when a job finishes (D42).
 * Real git repos and real worktrees — the classification is the whole point,
 * so nothing about git is mocked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
  implementation: { adapter: codex, model: m }
`);

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

const trash: string[] = [];
let openDaemon: Daemon | null = null;
// Env this file overrides, restored after each test: leaving AGVSR_WORKTREES set
// would point a later test at this file's scratch dir — or, once restored mid-test,
// at the user's real ~/.config/agvsr/worktrees.
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

/** A repo on `main` with one commit, plus a scratch worktrees dir. */
async function setup() {
  const base = join(tmpdir(), `agvsr-reclaim-${randomUUID()}`);
  trash.push(base);
  const repo = join(base, "repo");
  const wts = join(base, "worktrees");
  mkdirSync(repo, { recursive: true });

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);

  setEnv("AGVSR_WORKTREES", wts);
  // Seeding is a separate feature; keep this test about reclamation only.
  setEnv("AGVSR_SEED_PATHS", "off");

  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const sock = join(base, "d.sock");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: join(base, "d.sqlite"),
    team: TEAM,
    interruptRunningJobsOnStart: false,
    turnRunner: async (d) => ({
      events: [{ kind: "result", ok: true, text: d.role }],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }),
  });
  openDaemon = daemon;
  return { repo, sock, daemon };
}

async function waitFor(check: () => Promise<boolean>, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
}

describe("automatic worktree reclamation (D42)", () => {
  it("removes a finished job's clean, fully-merged worktree and its branch", async () => {
    const { repo, sock } = await setup();
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "reclaim", cwd: repo });
    expect(created.ok).toBe(true);
    const job = created.ok ? created.result.job : null;
    const worktree = job!.worktree!;
    expect(existsSync(worktree)).toBe(true);

    await c.request("job.complete", { job_id: job!.id, result: "done" });
    await waitFor(async () => !existsSync(worktree));

    expect(existsSync(worktree)).toBe(false);
    // The branch went with it — it held nothing main did not already have.
    expect(git(repo, ["rev-parse", "--verify", job!.branch!]).ok).toBe(false);

    const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: job!.id });
    const note = (logs.ok ? logs.result.messages : []).find((m) => m.body.includes("Reclaimed"));
    expect(note?.body).toContain(worktree);
    c.close();
  });

  it("keeps a worktree that still holds unmerged commits", async () => {
    const { repo, sock } = await setup();
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "unmerged", cwd: repo });
    const job = created.ok ? created.result.job : null;
    const worktree = job!.worktree!;

    // Work the human has not merged anywhere yet.
    writeFileSync(join(worktree, "feature.txt"), "work in progress\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "feature"]);

    await c.request("job.fail", { job_id: job!.id, reason: "gave up" });
    await Bun.sleep(400);

    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ["rev-parse", "--verify", job!.branch!]).ok).toBe(true);
    c.close();
  });

  it("keeps a worktree with uncommitted changes", async () => {
    const { repo, sock } = await setup();
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "dirty", cwd: repo });
    const job = created.ok ? created.result.job : null;
    const worktree = job!.worktree!;

    writeFileSync(join(worktree, "scratch.txt"), "uncommitted\n");

    await c.request("job.fail", { job_id: job!.id, reason: "gave up" });
    await Bun.sleep(400);

    expect(existsSync(worktree)).toBe(true);
    c.close();
  });

  it("does nothing when reclamation is turned off", async () => {
    const prev = process.env.AGVSR_AUTO_RECLAIM;
    process.env.AGVSR_AUTO_RECLAIM = "0";
    try {
      const { sock, repo } = await setup();
      const c = await Client.connect(sock);
      const created = await c.request<{ job: Job }>("job.create", { goal: "keep", cwd: repo });
      const job = created.ok ? created.result.job : null;
      const worktree = job!.worktree!;

      await c.request("job.complete", { job_id: job!.id, result: "done" });
      await Bun.sleep(400);

      expect(existsSync(worktree)).toBe(true);
      c.close();
    } finally {
      if (prev === undefined) delete process.env.AGVSR_AUTO_RECLAIM;
      else process.env.AGVSR_AUTO_RECLAIM = prev;
    }
  });
});
