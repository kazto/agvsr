import { describe, expect, it } from "bun:test";
import { Store } from "../src/daemon/store.ts";

describe("Store", () => {
  it("creates, reads, lists and updates jobs", () => {
    const store = new Store(":memory:");

    const a = store.createJob("add health endpoint", "/repo");
    expect(a.id).toBeTruthy();
    expect(a.status).toBe("running");
    expect(a.cwd).toBe("/repo");
    expect(a.branch).toBeNull();

    expect(store.getJob(a.id)).toMatchObject({ id: a.id, goal: "add health endpoint" });
    expect(store.getJob("nope")).toBeNull();

    const b = store.createJob("second", "/repo2");
    const ids = store.listJobs().map((j) => j.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    store.setJobStatus(a.id, "done");
    expect(store.getJob(a.id)!.status).toBe("done");

    store.close();
  });
});
