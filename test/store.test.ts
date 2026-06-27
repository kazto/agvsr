import { describe, expect, it } from "bun:test";
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
});
