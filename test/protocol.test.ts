import { describe, expect, it } from "bun:test";
import type { JobUpdate, Message, PushFrame, Request } from "../src/protocol.ts";

describe("PushFrame discriminated union", () => {
  it("msg.new frame round-trips through JSON without shape loss", () => {
    const message: Message = {
      id: "msg-1",
      job_id: "job-1",
      from_role: "supervisor",
      to_role: "user",
      kind: "message",
      body: "hello",
      refs: null,
      created_at: "2026-01-01T00:00:00.000Z",
      read_at: null,
    };
    const frame: PushFrame = { type: "push", event: "msg.new", data: message };
    const json = JSON.stringify(frame);
    const parsed = JSON.parse(json) as PushFrame;
    expect(parsed.type).toBe("push");
    expect(parsed.event).toBe("msg.new");
    if (parsed.event === "msg.new") {
      expect(parsed.data.id).toBe("msg-1");
      expect(parsed.data.job_id).toBe("job-1");
      expect(parsed.data.body).toBe("hello");
    }
  });

  it("job.update frame round-trips through JSON without shape loss", () => {
    const update: JobUpdate = {
      job_id: "job-2",
      status: "done",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    const frame: PushFrame = { type: "push", event: "job.update", data: update };
    const json = JSON.stringify(frame);
    const parsed = JSON.parse(json) as PushFrame;
    expect(parsed.type).toBe("push");
    expect(parsed.event).toBe("job.update");
    if (parsed.event === "job.update") {
      expect(parsed.data.job_id).toBe("job-2");
      expect(parsed.data.status).toBe("done");
      expect(parsed.data.updated_at).toBe("2026-01-02T00:00:00.000Z");
    }
  });

  it("all job lifecycle statuses are valid in job.update", () => {
    const statuses = ["running", "done", "failed", "interrupted"] as const;
    for (const status of statuses) {
      const frame: PushFrame = {
        type: "push",
        event: "job.update",
        data: { job_id: "j", status, updated_at: new Date().toISOString() },
      };
      const parsed = JSON.parse(JSON.stringify(frame)) as PushFrame;
      expect(parsed.event).toBe("job.update");
      if (parsed.event === "job.update") {
        expect(parsed.data.status).toBe(status);
      }
    }
  });

  it("msg.new and job.update are distinct variants of PushFrame", () => {
    const msgFrame: PushFrame = {
      type: "push",
      event: "msg.new",
      data: {
        id: "m1",
        job_id: "j1",
        from_role: "supervisor",
        to_role: "user",
        kind: "message",
        body: "test",
        refs: null,
        created_at: "2026-01-01T00:00:00.000Z",
        read_at: null,
      },
    };
    const updateFrame: PushFrame = {
      type: "push",
      event: "job.update",
      data: { job_id: "j1", status: "running", updated_at: "2026-01-01T00:00:00.000Z" },
    };
    expect(msgFrame.event).not.toBe(updateFrame.event);
  });
});

describe("job.watch request encoding", () => {
  it("encodes as a valid Request with no required params", () => {
    const req: Request = { id: "r1", type: "request", method: "job.watch" };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as Request;
    expect(parsed.type).toBe("request");
    expect(parsed.method).toBe("job.watch");
    expect(parsed.id).toBe("r1");
  });

  it("accepts optional empty params", () => {
    const req: Request = { id: "r2", type: "request", method: "job.watch", params: {} };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as Request;
    expect(parsed.method).toBe("job.watch");
  });
});
