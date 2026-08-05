import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/daemon/store.ts";
import type { TurnUsage } from "../src/adapters/types.ts";

describe("Store", () => {
  it("creates, reads, lists and updates jobs", () => {
    const store = new Store(":memory:");

    const a = store.createJob("add health endpoint", "/repo");
    expect(a.id).toBeTruthy();
    expect(a.status).toBe("running");
    expect(a.cwd).toBe("/repo");
    expect(a.branch).toBe(`agvsr/${a.id.slice(0, 8)}`);
    // UUID id: branch uses first 8 chars
    expect(a.branch).toMatch(/^agvsr\/[0-9a-f]{8}$/);

    expect(store.getJob(a.id)).toMatchObject({ id: a.id, goal: "add health endpoint" });
    expect(store.getJob("nope")).toBeNull();

    const b = store.createJob("second", "/repo2");
    const ids = store.listJobs().map((j) => j.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    store.setJobStatus(a.id, "done");
    expect(store.getJob(a.id)!.status).toBe("done");

    const msg = store.createMessage({
      job_id: a.id,
      from_role: "supervisor",
      to_role: "implementation",
      kind: "message",
      body: "please implement",
      refs: ["src/example.ts"],
    });
    expect(msg.id).toBeTruthy();
    expect(JSON.parse(msg.refs!)).toEqual(["src/example.ts"]);
    expect(store.listMessages(a.id).map((m) => m.id)).toContain(msg.id);

    store.markMessageRead(msg.id);
    expect(store.listMessages(a.id).find((m) => m.id === msg.id)!.read_at).toBeTruthy();

    expect(store.getAgentSession(a.id, "supervisor")).toBeNull();
    store.setAgentSession(a.id, "supervisor", "session-1");
    expect(store.getAgentSession(a.id, "supervisor")).toBe("session-1");
    store.setAgentSession(a.id, "supervisor", "session-2");
    expect(store.getAgentSession(a.id, "supervisor")).toBe("session-2");

    const interrupted = store.interruptRunningJobs();
    expect(interrupted.map((j) => j.id)).toEqual([b.id]);
    expect(store.getJob(b.id)!.status).toBe("interrupted");
    expect(store.interruptRunningJobs()).toEqual([]);

    store.close();
  });

  it("accepts a custom job id and uses it for the branch name", () => {
    const store = new Store(":memory:");

    const j = store.createJob("add login page", "/repo", "login-feature");
    expect(j.id).toBe("login-feature");
    expect(j.branch).toBe("agvsr/login-feature");
    expect(store.getJob("login-feature")).toMatchObject({ id: "login-feature" });

    store.close();
  });

  it("defaults herdr mode fields to null in standalone mode", () => {
    const store = new Store(":memory:");
    const job = store.createJob("goal", "/repo");
    expect(job.workspace_id).toBeNull();
    expect(job.workspace_name).toBeNull();
    expect(job.caller_pane_id).toBeNull();
    expect(job.herdr_session).toBeNull();
    expect(store.getJob(job.id)).toMatchObject({ workspace_id: null, caller_pane_id: null });
    store.close();
  });

  it("persists herdr mode fields when createJob is given herdrInfo", () => {
    const store = new Store(":memory:");
    const job = store.createJob("goal", "/repo", undefined, {
      workspace_id: "w1",
      workspace_name: "agvsr",
      caller_pane_id: "w1:p1",
      herdr_session: "work",
    });
    expect(job).toMatchObject({
      workspace_id: "w1",
      workspace_name: "agvsr",
      caller_pane_id: "w1:p1",
      herdr_session: "work",
    });
    expect(store.getJob(job.id)).toMatchObject({ workspace_id: "w1", workspace_name: "agvsr" });
    store.close();
  });

  it("migrates an old-schema jobs table (pre-herdr columns) without data loss", () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-store-test-"));
    const dbPath = join(dir, "old.sqlite");

    const raw = new Database(dbPath, { create: true });
    raw.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        cwd TEXT NOT NULL, branch TEXT, worktree TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    raw
      .query(
        `INSERT INTO jobs (id, goal, status, cwd, branch, worktree, created_at, updated_at)
         VALUES ('old-job', 'legacy goal', 'running', '/repo', 'agvsr/old-job', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run();
    raw.close();

    const store = new Store(dbPath);
    expect(store.getJob("old-job")).toMatchObject({
      id: "old-job",
      goal: "legacy goal",
      workspace_id: null,
    });
    const created = store.createJob("new goal", "/repo");
    expect(created.workspace_id).toBeNull();
    store.close();
  });
});

describe("Store turn usage accounting (D32)", () => {
  const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
    input_tokens: 100,
    output_tokens: 200,
    cache_read_tokens: 300,
    cache_write_tokens: 400,
    reasoning_tokens: 0,
    cost_usd: 1.5,
    ...over,
  });

  it("reports empty totals for a job with no recorded turns", () => {
    const store = new Store(":memory:");
    const job = store.createJob("goal", "/repo");
    const result = store.jobUsage(job.id);
    expect(result.totals.turns).toBe(0);
    expect(result.totals.cost_usd).toBe(0);
    expect(result.totals.cost_partial).toBe(false);
    expect(result.by_role).toEqual([]);
    store.close();
  });

  it("sums tokens and cost across turns and groups them by role/adapter/model", () => {
    const store = new Store(":memory:");
    const job = store.createJob("goal", "/repo");
    const rec = (role: string, adapter: string, model: string, u: TurnUsage) =>
      store.recordTurnUsage({ job_id: job.id, role, adapter, model, usage: u });

    rec("supervisor", "claude-code", "claude-opus-4-8", usage());
    rec("supervisor", "claude-code", "claude-opus-4-8", usage({ cost_usd: 2.5 }));
    rec("design", "claude-code", "claude-sonnet-4-6", usage({ cost_usd: 0.25 }));

    const { totals, by_role } = store.jobUsage(job.id);
    expect(totals.turns).toBe(3);
    expect(totals.input_tokens).toBe(300);
    expect(totals.output_tokens).toBe(600);
    expect(totals.cache_read_tokens).toBe(900);
    expect(totals.cache_write_tokens).toBe(1200);
    expect(totals.cost_usd).toBeCloseTo(4.25, 6);
    expect(totals.cost_partial).toBe(false);

    expect(by_role).toHaveLength(2);
    // Ordered most expensive first, so the biggest quota burner is on top.
    expect(by_role[0]).toMatchObject({ role: "supervisor", turns: 2 });
    expect(by_role[0]!.cost_usd).toBeCloseTo(4.0, 6);
    expect(by_role[1]).toMatchObject({ role: "design", turns: 1 });
    store.close();
  });

  it("marks a group partial when any turn reported no cost, without dropping its tokens", () => {
    const store = new Store(":memory:");
    const job = store.createJob("goal", "/repo");
    store.recordTurnUsage({
      job_id: job.id,
      role: "supervisor",
      adapter: "claude-code",
      model: "claude-opus-4-8",
      usage: usage({ cost_usd: 1.0 }),
    });
    store.recordTurnUsage({
      job_id: job.id,
      role: "implementation",
      adapter: "codex",
      model: "gpt-5-codex",
      usage: usage({ cost_usd: null, reasoning_tokens: 42 }),
    });

    const { totals, by_role } = store.jobUsage(job.id);
    expect(totals.turns).toBe(2);
    expect(totals.cost_usd).toBeCloseTo(1.0, 6); // codex contributes tokens but no cost
    expect(totals.cost_partial).toBe(true);
    expect(totals.reasoning_tokens).toBe(42);
    expect(totals.input_tokens).toBe(200);

    const codex = by_role.find((r) => r.adapter === "codex")!;
    expect(codex.cost_usd).toBe(0);
    expect(codex.cost_partial).toBe(true);
    const claude = by_role.find((r) => r.adapter === "claude-code")!;
    expect(claude.cost_partial).toBe(false);
    store.close();
  });

  it("keeps per-job aggregates separate and reports across all jobs", () => {
    const store = new Store(":memory:");
    const a = store.createJob("cheap job", "/repo");
    const b = store.createJob("expensive job", "/repo");
    const rec = (jobId: string, u: TurnUsage) =>
      store.recordTurnUsage({
        job_id: jobId,
        role: "supervisor",
        adapter: "claude-code",
        model: "claude-opus-4-8",
        usage: u,
      });
    rec(a.id, usage({ cost_usd: 1.0 }));
    rec(b.id, usage({ cost_usd: 5.0 }));
    rec(b.id, usage({ cost_usd: 5.0 }));

    expect(store.jobUsage(a.id).totals.cost_usd).toBeCloseTo(1.0, 6);
    expect(store.jobUsage(b.id).totals.cost_usd).toBeCloseTo(10.0, 6);

    const all = store.usageReport();
    expect(all.totals.turns).toBe(3);
    expect(all.totals.cost_usd).toBeCloseTo(11.0, 6);
    expect(all.by_job).toHaveLength(2);
    // Costliest job first, and each row carries the goal/status for display.
    expect(all.by_job[0]).toMatchObject({ job_id: b.id, goal: "expensive job", status: "running" });
    expect(all.by_job[1]).toMatchObject({ job_id: a.id, goal: "cheap job" });

    const scoped = store.usageReport(a.id);
    expect(scoped.by_job).toHaveLength(1);
    expect(scoped.totals.cost_usd).toBeCloseTo(1.0, 6);
    store.close();
  });

  it("adds the turn_usage table to a database created before D32", () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-store-usage-"));
    const file = join(dir, "old.sqlite");
    const raw = new Database(file, { create: true });
    raw.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      cwd TEXT NOT NULL, branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    raw
      .query(
        `INSERT INTO jobs (id, goal, status, cwd, branch, created_at, updated_at)
       VALUES ('old-1', 'legacy goal', 'done', '/repo', 'agvsr/old-1', '2026-01-01', '2026-01-01')`,
      )
      .run();
    raw.close();

    const store = new Store(file);
    expect(store.getJob("old-1")).toMatchObject({ goal: "legacy goal", status: "done" });
    expect(store.jobUsage("old-1").totals.turns).toBe(0);
    store.recordTurnUsage({
      job_id: "old-1",
      role: "supervisor",
      adapter: "claude-code",
      model: "claude-opus-4-8",
      usage: usage(),
    });
    expect(store.jobUsage("old-1").totals.turns).toBe(1);
    store.close();
  });
});
