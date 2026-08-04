import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/daemon/store.ts";

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
