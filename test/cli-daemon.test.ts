import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonNotRunningError, type Client } from "../src/ipc/transport.ts";
import { restartDaemonDetached, startDaemonDetached } from "../src/cli/daemon.ts";

afterEach(() => {
  delete process.env.AGVSR_SOCK;
  delete process.env.AGVSR_STORE;
});

describe("daemon start helper", () => {
  it("does not spawn when the daemon is already running", async () => {
    let connectCount = 0;
    let spawnCount = 0;
    let closed = false;

    const result = await startDaemonDetached({
      endpoint: "/tmp/agvsr.sock",
      bunExec: "bun",
      scriptPath: "/repo/src/cli/agvsr.ts",
      connect: async () => {
        connectCount++;
        return { close: () => (closed = true) } as unknown as Client;
      },
      spawn: (() => {
        spawnCount++;
        throw new Error("spawn should not be called");
      }) as typeof Bun.spawn,
    });

    expect(result).toEqual({ alreadyRunning: true, started: false });
    expect(connectCount).toBe(1);
    expect(spawnCount).toBe(0);
    expect(closed).toBe(true);
  });

  it("spawns detached daemon once and waits for readiness", async () => {
    let connectCount = 0;
    let spawnArgs: Array<string> | null = null;
    let spawnOptions: Parameters<typeof Bun.spawn>[1] | null = null;
    let unrefCount = 0;
    const client = { close() {} } as unknown as Client;

    const result = await startDaemonDetached({
      endpoint: "/tmp/agvsr.sock",
      teamFile: "/tmp/team.yaml",
      bunExec: "bun",
      scriptPath: "/repo/src/cli/agvsr.ts",
      connect: async () => {
        connectCount++;
        if (connectCount === 1) throw new DaemonNotRunningError("/tmp/agvsr.sock");
        return client;
      },
      spawn: ((args, options) => {
        spawnArgs = args;
        spawnOptions = options;
        return { unref: () => unrefCount++ } as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
      sleep: async () => {},
      readyPollMs: 1,
      readyTimeoutMs: 50,
    });

    expect(result).toEqual({ alreadyRunning: false, started: true });
    expect(connectCount).toBe(2);
    expect(spawnArgs).toEqual([
      "bun",
      "/repo/src/cli/agvsr.ts",
      "daemon",
      "--team",
      "/tmp/team.yaml",
    ]);
    expect(spawnOptions).toEqual({
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(unrefCount).toBe(1);
  });

  it("reuses the same detached spawn path for restart", () => {
    let spawnArgs: Array<string> | null = null;
    let unrefCount = 0;

    restartDaemonDetached({
      bunExec: "bun",
      scriptPath: "/repo/src/cli/agvsr.ts",
      teamFile: "/tmp/team.yaml",
      spawn: ((args) => {
        spawnArgs = args;
        return { unref: () => unrefCount++ } as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn,
    });

    expect(spawnArgs).toEqual([
      "bun",
      "/repo/src/cli/agvsr.ts",
      "daemon",
      "--team",
      "/tmp/team.yaml",
    ]);
    expect(unrefCount).toBe(1);
  });
});

describe("daemon start CLI smoke", () => {
  it("starts the daemon in the background and is idempotent when already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-cli-daemon-"));
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const env = { ...process.env, AGVSR_SOCK: sock, AGVSR_STORE: db };

    try {
      const start1 = Bun.spawn(["bun", "run", "src/cli/agvsr.ts", "daemon", "start"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [start1Out, start1Err, start1Code] = await Promise.all([
        new Response(start1.stdout).text(),
        new Response(start1.stderr).text(),
        start1.exited,
      ]);
      expect(start1Code).toBe(0);
      expect(start1Out).toContain("daemon started");
      expect(start1Err).toBe("");

      const ping = Bun.spawn(["bun", "run", "src/cli/agvsr.ts", "ping"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [pingOut, pingErr, pingCode] = await Promise.all([
        new Response(ping.stdout).text(),
        new Response(ping.stderr).text(),
        ping.exited,
      ]);
      expect(pingCode).toBe(0);
      expect(pingOut).toContain("pong");
      expect(pingErr).toBe("");

      const start2 = Bun.spawn(["bun", "run", "src/cli/agvsr.ts", "daemon", "start"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [start2Out, start2Err, start2Code] = await Promise.all([
        new Response(start2.stdout).text(),
        new Response(start2.stderr).text(),
        start2.exited,
      ]);
      expect(start2Code).toBe(0);
      expect(start2Out).toContain("daemon already running");
      expect(start2Err).toBe("");

      const stop = Bun.spawn(["bun", "run", "src/cli/agvsr.ts", "daemon", "stop"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stopOut, stopErr, stopCode] = await Promise.all([
        new Response(stop.stdout).text(),
        new Response(stop.stderr).text(),
        stop.exited,
      ]);
      expect(stopCode).toBe(0);
      expect(stopOut).toContain("daemon stopping");
      expect(stopErr).toBe("");
    } finally {
      const cleanup = Bun.spawn(["bun", "run", "src/cli/agvsr.ts", "daemon", "stop"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([
        cleanup.exited,
        new Response(cleanup.stdout).text(),
        new Response(cleanup.stderr).text(),
      ]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
