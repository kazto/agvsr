import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { TurnDispatch } from "../src/daemon/daemon.ts";
import type { HookEvent } from "../src/hooks.ts";
import type { Job } from "../src/protocol.ts";

const TEAM_YAML = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
hooks:
  on_job_done: echo done
  on_job_failed: echo failed
  on_supervisor_message: echo msg
  on_job_stalled: echo stalled
`;

function makeBase() {
  return join(tmpdir(), `agvsr-hooks-${randomUUID()}`);
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try {
      rmSync(p);
    } catch {}
  }
}

async function makeDaemon(
  yaml: string,
  fired: { name: string; event: HookEvent }[],
  runner: (
    d: TurnDispatch,
  ) => ReturnType<(d: TurnDispatch) => Promise<import("../src/adapters/types.ts").TurnResult>>,
) {
  const base = makeBase();
  const sock = `${base}.sock`;
  const db = `${base}.sqlite`;
  const repo = `${base}-repo`;
  mkdirSync(repo, { recursive: true });
  const team = parseTeam(yaml);
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: runner,
    hookRunner: (cmd, event) => {
      fired.push({ name: cmd, event });
    },
  });
  return { daemon, sock, db, base, repo };
}

describe("event hooks (D26)", () => {
  it("fires on_job_done when a job completes via agvsr_complete", async () => {
    const fired: { name: string; event: HookEvent }[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(TEAM_YAML, fired, async (d) => ({
      events: [],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "ship it", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    const done = await c.request("job.complete", { job_id: jobId, result: "all done" });
    expect(done.ok).toBe(true);

    expect(
      fired.some(
        (f) =>
          f.name === "echo done" &&
          f.event.event === "job_done" &&
          f.event.job_id === jobId &&
          f.event.result === "all done",
      ),
    ).toBe(true);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("fires on_job_failed when a job fails via agvsr_fail", async () => {
    const fired: { name: string; event: HookEvent }[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(TEAM_YAML, fired, async (d) => ({
      events: [],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "will fail", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    const failed = await c.request("job.fail", { job_id: jobId, reason: "cannot proceed" });
    expect(failed.ok).toBe(true);

    expect(
      fired.some(
        (f) =>
          f.name === "echo failed" &&
          f.event.event === "job_failed" &&
          f.event.job_id === jobId &&
          f.event.reason === "cannot proceed",
      ),
    ).toBe(true);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("fires on_job_failed when job.stop is called", async () => {
    const fired: { name: string; event: HookEvent }[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(TEAM_YAML, fired, async (d) => ({
      events: [],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "stop me", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";

    await c.request("job.stop", { job_id: jobId });

    expect(fired.some((f) => f.name === "echo failed" && f.event.event === "job_failed")).toBe(
      true,
    );

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("fires on_supervisor_message when supervisor sends to user", async () => {
    const fired: { name: string; event: HookEvent }[] = [];
    const seen: TurnDispatch[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(TEAM_YAML, fired, async (d) => {
      seen.push(d);
      return { events: [], outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 } };
    });
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "supervisor talks",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);

    await c.request("msg.send", {
      from: "supervisor",
      job_id: jobId,
      to: "user",
      body: "Need your input.",
    });

    expect(
      fired.some(
        (f) =>
          f.name === "echo msg" &&
          f.event.event === "supervisor_message" &&
          f.event.body === "Need your input.",
      ),
    ).toBe(true);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("does not fire hooks when team has no hooks section", async () => {
    const noHooksYaml = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
`;
    const fired: { name: string; event: HookEvent }[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(noHooksYaml, fired, async (d) => ({
      events: [],
      outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
    }));
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", { goal: "no hooks", cwd: repo });
    expect(created.ok).toBe(true);
    const jobId = created.ok ? created.result.job.id : "";
    await c.request("job.complete", { job_id: jobId, result: "ok" });

    expect(fired.length).toBe(0);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });
});

describe("team.yaml hooks schema", () => {
  it("parses hooks alongside roles", () => {
    const team = parseTeam(TEAM_YAML);
    expect(team.hooks?.on_job_done).toBe("echo done");
    expect(team.hooks?.on_job_failed).toBe("echo failed");
    expect(team.hooks?.on_supervisor_message).toBe("echo msg");
    expect(team.hooks?.on_job_stalled).toBe("echo stalled");
  });

  it("accepts a team with no hooks key", () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
`);
    expect(team.hooks).toBeUndefined();
  });

  it("accepts partial hooks (only some keys set)", () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: m }
hooks:
  on_job_done: "notify-send done"
`);
    expect(team.hooks?.on_job_done).toBe("notify-send done");
    expect(team.hooks?.on_job_failed).toBeUndefined();
  });
});
