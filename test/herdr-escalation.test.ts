import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { TurnDispatch } from "../src/daemon/daemon.ts";
import type { HerdrClient } from "../src/herdr/client.ts";
import type { Job } from "../src/protocol.ts";

const TEAM_YAML = `
roles:
  supervisor: { adapter: claude-code, model: claude-opus-4-8 }
  implementation: { adapter: codex, model: gpt-5-codex }
`;

function makeBase() {
  return join(tmpdir(), `agvsr-herdr-${randomUUID()}`);
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try {
      rmSync(p);
    } catch {}
  }
}

interface FakeHerdrCalls {
  resolveWorkspaceName: Array<{ workspaceId: string; session?: string | null }>;
  promptAgent: Array<{ paneId: string; text: string; session?: string | null }>;
}

function makeFakeHerdrClient(workspaceName: string | null): {
  client: HerdrClient;
  calls: FakeHerdrCalls;
} {
  const calls: FakeHerdrCalls = { resolveWorkspaceName: [], promptAgent: [] };
  const client: HerdrClient = {
    async resolveWorkspaceName(workspaceId, session) {
      calls.resolveWorkspaceName.push({ workspaceId, session });
      return workspaceName;
    },
    async promptAgent(paneId, text, session) {
      calls.promptAgent.push({ paneId, text, session });
    },
  };
  return { client, calls };
}

async function makeDaemon(
  herdrClient: HerdrClient,
  runner: (
    d: TurnDispatch,
  ) => ReturnType<(d: TurnDispatch) => Promise<import("../src/adapters/types.ts").TurnResult>>,
) {
  const base = makeBase();
  const sock = `${base}.sock`;
  const db = `${base}.sqlite`;
  const repo = `${base}-repo`;
  mkdirSync(repo, { recursive: true });
  const team = parseTeam(TEAM_YAML);
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: runner,
    herdrClient,
  });
  return { daemon, sock, db, base, repo };
}

describe("herdr integration (D29-D31)", () => {
  it("resolves and stores the herdr workspace name at job creation", async () => {
    const { client, calls } = makeFakeHerdrClient("agvsr");
    const seen: TurnDispatch[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(client, async (d) => {
      seen.push(d);
      return { events: [], outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 } };
    });
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "herdr mode job",
      cwd: repo,
      workspace_id: "w1",
      caller_pane_id: "w1:p1",
      herdr_session: "work",
    });
    expect(created.ok).toBe(true);
    const job = created.ok ? created.result.job : null;
    expect(job?.workspace_id).toBe("w1");
    expect(job?.workspace_name).toBe("agvsr");
    expect(job?.caller_pane_id).toBe("w1:p1");
    expect(job?.herdr_session).toBe("work");
    expect(calls.resolveWorkspaceName).toEqual([{ workspaceId: "w1", session: "work" }]);
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    expect(seen[0]?.env.HERDR_ENV).toBe("1");
    expect(seen[0]?.env.HERDR_WORKSPACE_ID).toBe("w1");
    expect(seen[0]?.env.HERDR_PANE_ID).toBe("w1:p1");
    expect(seen[0]?.env.HERDR_SESSION).toBe("work");

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("leaves workspace fields null in standalone mode (no herdr params)", async () => {
    const { client, calls } = makeFakeHerdrClient("agvsr");
    const seen: TurnDispatch[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(client, async (d) => {
      seen.push(d);
      return { events: [], outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 } };
    });
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "standalone job",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    const job = created.ok ? created.result.job : null;
    expect(job?.workspace_id).toBeNull();
    expect(job?.workspace_name).toBeNull();
    expect(job?.caller_pane_id).toBeNull();
    expect(calls.resolveWorkspaceName).toEqual([]);
    for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(5);
    expect(seen[0]?.env.HERDR_ENV).toBeUndefined();
    expect(seen[0]?.env.HERDR_WORKSPACE_ID).toBeUndefined();
    expect(seen[0]?.env.HERDR_PANE_ID).toBeUndefined();

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("prompts the caller pane when supervisor escalates to the user", async () => {
    const { client, calls } = makeFakeHerdrClient("agvsr");
    const seen: TurnDispatch[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(client, async (d) => {
      seen.push(d);
      return { events: [], outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 } };
    });
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "escalation test",
      cwd: repo,
      workspace_id: "w1",
      caller_pane_id: "w1:p1",
      herdr_session: "work",
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

    for (let i = 0; i < 50 && calls.promptAgent.length < 1; i++) await Bun.sleep(5);
    expect(calls.promptAgent).toHaveLength(1);
    expect(calls.promptAgent[0]?.paneId).toBe("w1:p1");
    expect(calls.promptAgent[0]?.session).toBe("work");
    expect(calls.promptAgent[0]?.text).toContain("Need your input.");
    expect(calls.promptAgent[0]?.text).toContain(`agvsr tell ${jobId}`);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });

  it("does not prompt any pane in standalone mode (no caller_pane_id)", async () => {
    const { client, calls } = makeFakeHerdrClient("agvsr");
    const seen: TurnDispatch[] = [];
    const { daemon, sock, db, repo } = await makeDaemon(client, async (d) => {
      seen.push(d);
      return { events: [], outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 } };
    });
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "standalone escalation",
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
    await Bun.sleep(50);
    expect(calls.promptAgent).toEqual([]);

    c.close();
    await daemon.close();
    cleanup(sock, db, `${db}-wal`, `${db}-shm`, repo);
  });
});
