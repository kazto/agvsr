import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseTeam } from "../src/config/team.ts";
import { Client } from "../src/ipc/transport.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, PushFrame } from "../src/protocol.ts";

setDefaultTimeout(15000);

let daemon: Daemon | null = null;
let tmp: string;
let sock: string;
let db: string;
let repo: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `agvsr-jobupdate-${randomUUID()}`);
  sock = join(tmp, "agvsrd.sock");
  db = join(tmp, "store.sqlite");
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });

  const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

  daemon = await startDaemon({
    endpoint: sock,
    storeFile: db,
    team,
    interruptRunningJobsOnStart: false,
    turnRunner: async () => ({
      events: [],
      outcome: { sessionId: null, finalText: "", exitCode: 0 },
    }),
  });
});

afterEach(async () => {
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function jobUpdates(frames: PushFrame[], jobId: string): Array<{ status: string }> {
  return frames
    .filter((f): f is Extract<PushFrame, { event: "job.update" }> => f.event === "job.update")
    .filter((f) => f.data.job_id === jobId)
    .map((f) => ({ status: f.data.status }));
}

describe("daemon job.update push via real IPC", () => {
  it("job.watch returns { watching: true }", async () => {
    const c = await Client.connect(sock);
    const res = await c.request<{ watching: boolean }>("job.watch");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.result.watching).toBe(true);
    c.close();
  });

  it("job.create emits running once, job.complete emits done once", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    const watchRes = await c2.request("job.watch");
    expect(watchRes.ok).toBe(true);

    const created = await c1.request<{ job: Job }>("job.create", {
      goal: "lifecycle test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.message);
    const jobId = created.result.job.id;

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "running"));

    const done = await c1.request("job.complete", { job_id: jobId, result: "ok" });
    expect(done.ok).toBe(true);

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "done"));

    const updates = jobUpdates(pushed, jobId);
    expect(updates.filter((u) => u.status === "running").length).toBe(1);
    expect(updates.filter((u) => u.status === "done").length).toBe(1);
    expect(updates[0]!.status).toBe("running");
    expect(updates[1]!.status).toBe("done");

    c1.close();
    c2.close();
  });

  it("job.stop emits failed", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    await c2.request("job.watch");

    const created = await c1.request<{ job: Job }>("job.create", { goal: "stop test", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "running"));

    const stopped = await c1.request("job.stop", { job_id: jobId });
    expect(stopped.ok).toBe(true);

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "failed"));

    const updates = jobUpdates(pushed, jobId);
    expect(updates.filter((u) => u.status === "failed").length).toBe(1);

    c1.close();
    c2.close();
  });

  it("job.kill emits interrupted", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    await c2.request("job.watch");

    const created = await c1.request<{ job: Job }>("job.create", { goal: "kill test", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "running"));

    const killed = await c1.request("job.kill", { job_id: jobId });
    expect(killed.ok).toBe(true);

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "interrupted"));

    const updates = jobUpdates(pushed, jobId);
    expect(updates.filter((u) => u.status === "interrupted").length).toBe(1);

    c1.close();
    c2.close();
  });

  it("job.fail emits failed", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    await c2.request("job.watch");

    const created = await c1.request<{ job: Job }>("job.create", { goal: "fail test", cwd: repo });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "running"));

    const failed = await c1.request("job.fail", { job_id: jobId, reason: "manual fail" });
    expect(failed.ok).toBe(true);

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "failed"));

    const updates = jobUpdates(pushed, jobId);
    expect(updates.filter((u) => u.status === "failed").length).toBe(1);

    c1.close();
    c2.close();
  });

  it("job.update carries job_id and updated_at fields", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    await c2.request("job.watch");

    const created = await c1.request<{ job: Job }>("job.create", {
      goal: "payload test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    await waitFor(() => jobUpdates(pushed, jobId).some((u) => u.status === "running"));

    const updateFrames = pushed.filter(
      (f): f is Extract<PushFrame, { event: "job.update" }> =>
        f.event === "job.update" && f.data.job_id === jobId,
    );
    expect(updateFrames.length).toBeGreaterThan(0);
    const first = updateFrames[0]!;
    expect(first.data.job_id).toBe(jobId);
    expect(first.data.updated_at).toBeTruthy();
    expect(new Date(first.data.updated_at).getTime()).toBeGreaterThan(0);

    c1.close();
    c2.close();
  });

  it("pre-subscription transitions are not delivered after subscription", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);

    // Create and complete a job BEFORE subscribing
    const created = await c1.request<{ job: Job }>("job.create", {
      goal: "pre-sub test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    const stopped = await c1.request("job.stop", { job_id: jobId });
    expect(stopped.ok).toBe(true);

    // Subscribe AFTER transitions have happened
    const pushed: PushFrame[] = [];
    c2.onPush = (f) => pushed.push(f);
    const watchRes = await c2.request("job.watch");
    expect(watchRes.ok).toBe(true);

    // Wait a bit and assert no pushes for the already-completed job
    await Bun.sleep(50);
    const forJob = pushed.filter((f) => f.event === "job.update" && f.data.job_id === jobId);
    expect(forJob.length).toBe(0);

    c1.close();
    c2.close();
  });

  it("multiple job.watch subscribers each receive the same update", async () => {
    const c1 = await Client.connect(sock);
    const c2 = await Client.connect(sock);
    const c3 = await Client.connect(sock);

    const pushed2: PushFrame[] = [];
    c2.onPush = (f) => pushed2.push(f);
    await c2.request("job.watch");

    const pushed3: PushFrame[] = [];
    c3.onPush = (f) => pushed3.push(f);
    await c3.request("job.watch");

    const created = await c1.request<{ job: Job }>("job.create", {
      goal: "fanout test",
      cwd: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error();
    const jobId = created.result.job.id;

    await waitFor(
      () =>
        jobUpdates(pushed2, jobId).some((u) => u.status === "running") &&
        jobUpdates(pushed3, jobId).some((u) => u.status === "running"),
    );

    expect(jobUpdates(pushed2, jobId).filter((u) => u.status === "running").length).toBe(1);
    expect(jobUpdates(pushed3, jobId).filter((u) => u.status === "running").length).toBe(1);

    c1.close();
    c2.close();
    c3.close();
  });
});
