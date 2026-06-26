import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "../src/ipc/transport.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, PingResult, RoleSummary } from "../src/protocol.ts";

const tmp = join(tmpdir(), `agvsr-test-${randomUUID()}`);
const sock = `${tmp}.sock`;
const store = `${tmp}.sqlite`;

let daemon: Daemon;

beforeAll(async () => {
  process.env.AGVSR_SOCK = sock;
  process.env.AGVSR_STORE = store;
  process.env.AGVSR_TEAM = join(import.meta.dir, "..", "examples", "team.yaml");
  const { startDaemon } = await import("../src/daemon/daemon.ts");
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon.close();
  for (const f of [sock, store, `${store}-wal`, `${store}-shm`]) {
    try {
      rmSync(f);
    } catch {}
  }
});

describe("CLI <-> daemon over local IPC", () => {
  it("responds to ping", async () => {
    const c = await Client.connect(sock);
    const res = await c.request<PingResult>("ping");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.pong).toBe(true);
    c.close();
  });

  it("creates and lists jobs (persisted by the daemon)", async () => {
    const c = await Client.connect(sock);
    const created = await c.request<{ job: Job }>("job.create", {
      goal: "do a thing",
      cwd: "/repo",
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.result.job.id : "";

    const got = await c.request<{ job: Job }>("job.get", { id });
    expect(got.ok && got.result.job.goal).toBe("do a thing");

    const list = await c.request<{ jobs: Job[] }>("job.list");
    expect(list.ok && list.result.jobs.some((j) => j.id === id)).toBe(true);
    c.close();
  });

  it("rejects an empty goal", async () => {
    const c = await Client.connect(sock);
    const res = await c.request("job.create", { goal: "  ", cwd: "/repo" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_request");
    c.close();
  });

  it("returns the configured team roles", async () => {
    const c = await Client.connect(sock);
    const res = await c.request<{ roles: RoleSummary[] }>("team.get");
    expect(res.ok).toBe(true);
    if (res.ok) {
      const names = res.result.roles.map((r) => r.name);
      expect(names).toContain("supervisor");
      expect(names).toContain("qa");
    }
    c.close();
  });
});
