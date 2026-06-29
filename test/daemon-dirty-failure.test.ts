import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { runTurn } from "../src/adapters/run.ts";
import type { AgentSpec, CliDriver } from "../src/adapters/types.ts";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  }
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

function timeoutDriver(): CliDriver {
  return {
    adapter: "claude-code",
    buildSpawn: () => ({
      bin: "bun",
      args: ["-e", `await new Promise((resolve) => setTimeout(resolve, 250));`],
    }),
    createParser: () => ({
      push: () => [],
      sessionId: () => null,
      finalText: () => "",
    }),
  };
}

describe("daemon dirty worktree failure reporting", () => {
  const base = join(tmpdir(), `agvsr-dirty-failure-${randomUUID()}`);
  const sock = join(base, "daemon.sock");
  const db = join(base, "store.sqlite");
  const configDir = join(base, "config");
  const repoBase = join(base, "repo-base");
  let daemon: { close(): Promise<void> } | null = null;

  beforeAll(async () => {
    mkdirSync(base, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = configDir;

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({
      endpoint: sock,
      storeFile: db,
      team: parseTeam(`
roles:
  supervisor:
    adapter: claude-code
    model: claude-opus-4-8
    idle_timeout_ms: 50
    hard_timeout_ms: 500
`),
      interruptRunningJobsOnStart: false,
      turnRunner: async (dispatch) => {
        const spec: AgentSpec = {
          role: dispatch.role,
          adapter: dispatch.adapter as AgentSpec["adapter"],
          model: dispatch.model,
          cwd: dispatch.effectiveCwd,
          systemPrompt: dispatch.systemPrompt,
          env: dispatch.env,
        };
        return runTurn(timeoutDriver(), spec, dispatch.sessionId, dispatch.message, {
          idleTimeoutMs: dispatch.idleTimeoutMs,
          hardTimeoutMs: dispatch.hardTimeoutMs,
          onProgress: dispatch.onProgress,
          signal: dispatch.signal,
        });
      },
    });
  });

  afterAll(async () => {
    if (daemon) await daemon.close();
    delete process.env.XDG_CONFIG_HOME;
    for (const f of [sock, db, `${db}-wal`, `${db}-shm`, base]) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {}
    }
  });

  it("appends recoverable dirty-worktree guidance to the terminal failure text", async () => {
    const repo = makeRepo(repoBase);
    const client = await Client.connect(sock);
    const created = await client.request<{
      job: { id: string; branch: string | null; worktree: string | null; status: string };
    }>("job.create", {
      goal: "timeout with dirty worktree",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("job.create failed");

    const job = created.result.job;
    expect(job.worktree).not.toBeNull();
    if (!job.worktree) throw new Error("missing worktree");
    writeFileSync(join(job.worktree, "tracked.txt"), "dirty");

    for (let i = 0; i < 200; i++) {
      const got = await client.request<{ job: { status: string } }>("job.get", { id: job.id });
      if (got.ok && got.result.job.status === "failed") break;
      await Bun.sleep(10);
    }

    const logs = await client.request<{ messages: Array<{ kind: string; body: string }> }>(
      "msg.list",
      {
        job_id: job.id,
      },
    );
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("msg.list failed");

    const failure = logs.result.messages.find((m) => m.kind === "failure");
    expect(failure).toBeTruthy();
    const body = failure?.body ?? "";
    expect(body).toContain(job.worktree);
    expect(body).toContain("変更ファイル数 1");
    expect(body).toContain(`ブランチ ${job.branch}`);
    expect(body).toContain("git でコミットして回収可");

    client.close();
  });
});
