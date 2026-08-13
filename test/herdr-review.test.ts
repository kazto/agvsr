import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import { resolveReviewAgent, type Daemon, type ReviewerKind } from "../src/daemon/daemon.ts";
import type { HerdrAgent, HerdrClient } from "../src/herdr/client.ts";
import type { Job, Message } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: codex, model: supervisor-model }
  implementation: { adapter: codex, model: implementation-model }
  qa: { adapter: claude-code, model: qa-model }
`);

const agent = (pane: string, workspace: string, kind: ReviewerKind): HerdrAgent => ({
  pane_id: pane,
  workspace_id: workspace,
  agent: kind,
  agent_status: "idle",
  cwd: `/work/${workspace}`,
});

describe("resolveReviewAgent", () => {
  it("ignores an earlier same-kind agent from another workspace", () => {
    const result = resolveReviewAgent({
      agents: [agent("w1:p2", "w1", "claude"), agent("w6:p1", "w6", "claude")],
      workspaceId: "w6",
      reviewerKind: "claude",
      requesterAdapter: "codex",
    });
    expect(result).toEqual({ ok: true, agent: agent("w6:p1", "w6", "claude") });
  });

  it("rejects an explicitly requested cross-workspace pane", () => {
    const result = resolveReviewAgent({
      agents: [agent("w1:p2", "w1", "claude"), agent("w6:p1", "w6", "claude")],
      workspaceId: "w6",
      reviewerKind: "claude",
      requesterAdapter: "codex",
      reviewerPaneId: "w1:p2",
    });
    expect(result).toMatchObject({ ok: false, code: "reviewer_mismatch" });
  });

  it("fails closed when the same workspace has multiple matching reviewers", () => {
    const result = resolveReviewAgent({
      agents: [agent("w6:p1", "w6", "claude"), agent("w6:p3", "w6", "claude")],
      workspaceId: "w6",
      reviewerKind: "claude",
      requesterAdapter: "codex",
    });
    expect(result).toMatchObject({ ok: false, code: "reviewer_ambiguous" });
  });

  it("allows the saved caller pane when it is the correct opposite-kind reviewer", () => {
    const result = resolveReviewAgent({
      agents: [agent("w6:p1", "w6", "claude")],
      workspaceId: "w6",
      reviewerKind: "claude",
      requesterAdapter: "codex",
      reviewerPaneId: "w6:p1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a reviewer of the requesting adapter's own kind", () => {
    const result = resolveReviewAgent({
      agents: [agent("w6:p2", "w6", "codex")],
      workspaceId: "w6",
      reviewerKind: "codex",
      requesterAdapter: "codex",
    });
    expect(result).toMatchObject({ ok: false, code: "reviewer_same_kind" });
  });
});

interface Harness {
  daemon: Daemon;
  client: Client;
  base: string;
  prompts: Array<{ pane: string; text: string; session?: string | null }>;
  agents: HerdrAgent[];
}

async function setup(): Promise<Harness> {
  const base = join(tmpdir(), `agvsr-review-${randomUUID()}`);
  const repo = join(base, "repo");
  const socket = join(base, "daemon.sock");
  const storeFile = join(base, "store.sqlite");
  mkdirSync(repo, { recursive: true });
  const agents = [agent("w1:p2", "w1", "claude"), agent("w6:p1", "w6", "claude")];
  const prompts: Harness["prompts"] = [];
  const herdrClient: HerdrClient = {
    async resolveWorkspaceName(workspaceId) {
      return workspaceId === "w6" ? "growllover" : null;
    },
    async promptAgent() {},
    async listAgents() {
      return { ok: true, agents };
    },
    async promptAgentChecked(pane, text, session) {
      prompts.push({ pane, text, session });
      return { ok: true };
    },
  };
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  const daemon = await startDaemon({
    endpoint: socket,
    storeFile,
    team: TEAM,
    herdrClient,
    interruptRunningJobsOnStart: false,
    turnRunner: async (dispatch) => ({
      events: [{ kind: "tool_use", name: "test", input: {} }],
      outcome: { sessionId: `${dispatch.role}-session`, finalText: "", exitCode: 0 },
    }),
  });
  return { daemon, client: await Client.connect(socket), base, prompts, agents };
}

describe("review.request", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (!harness) return;
    harness.client.close();
    await harness.daemon.close();
    rmSync(harness.base, { recursive: true, force: true });
    harness = null;
  });

  async function createJob(h: Harness): Promise<Job> {
    const created = await h.client.request<{ job: Job }>("job.create", {
      goal: "review safely",
      cwd: join(h.base, "repo"),
      workspace_id: "w6",
      caller_pane_id: "w6:p1",
      herdr_session: "work",
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.result.job;
  }

  it("delivers only to the matching workspace and records the verified pane", async () => {
    harness = await setup();
    const job = await createJob(harness);
    const response = await harness.client.request<{
      reviewer_pane_id: string;
      workspace_id: string;
    }>("review.request", {
      job_id: job.id,
      from_role: "implementation",
      reviewer_kind: "claude",
      body: "Review PR #123 at commit abc",
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.reviewer_pane_id).toBe("w6:p1");
      expect(response.result.workspace_id).toBe("w6");
    }
    expect(harness.prompts).toEqual([
      { pane: "w6:p1", text: "Review PR #123 at commit abc", session: "work" },
    ]);

    const listed = await harness.client.request<{ messages: Message[] }>("msg.list", {
      job_id: job.id,
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.result.messages.at(-1)?.body).toContain(
        "workspace=w6(growllover), reviewer=claude, pane=w6:p1",
      );
    }
  });

  it("rejects a cross-workspace pane without prompting either agent", async () => {
    harness = await setup();
    const job = await createJob(harness);
    const response = await harness.client.request("review.request", {
      job_id: job.id,
      from_role: "implementation",
      reviewer_kind: "claude",
      reviewer_pane_id: "w1:p2",
      body: "Review PR #123",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("reviewer_mismatch");
    expect(harness.prompts).toEqual([]);
  });

  it("rejects ambiguous reviewers instead of choosing the first", async () => {
    harness = await setup();
    harness.agents.push(agent("w6:p3", "w6", "claude"));
    const job = await createJob(harness);
    const response = await harness.client.request("review.request", {
      job_id: job.id,
      from_role: "implementation",
      reviewer_kind: "claude",
      body: "Review PR #123",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("reviewer_ambiguous");
    expect(harness.prompts).toEqual([]);
  });
});
