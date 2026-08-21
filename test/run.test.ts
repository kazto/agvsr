import { describe, expect, it } from "bun:test";
import { childProcessEnv, runTurn } from "../src/adapters/run.ts";
import type { AgentSpec, CliDriver, TurnParser, TurnUsage } from "../src/adapters/types.ts";

const spec: AgentSpec = {
  role: "implementation",
  adapter: "claude-code",
  model: "m",
  cwd: process.cwd(),
  systemPrompt: "SP",
};

function textParser(sessionId: string | null): TurnParser {
  let text = "";
  return {
    push(line) {
      text += text ? `\n${line}` : line;
      return [{ kind: "text", text: line }];
    },
    sessionId: () => sessionId,
    finalText: () => text,
  };
}

/** A driver backed by a tiny `bun -e` script that emits two lines. */
function fakeDriver(opts: { sessionId: string | null; resolve?: string }): CliDriver {
  return {
    adapter: "claude-code",
    buildSpawn: () => ({
      bin: "bun",
      args: ["-e", `process.stdout.write("alpha\\nbeta\\n")`],
    }),
    createParser: () => textParser(opts.sessionId),
    resolveSessionId: opts.resolve ? () => opts.resolve! : undefined,
    probeSession: opts.resolve ? () => ({ known: [] }) : undefined,
  };
}

function stderrDriver(opts: {
  sessionId: string | null;
  stderr: string;
  stdout: string;
}): CliDriver {
  return {
    adapter: "claude-code",
    buildSpawn: () => ({
      bin: "bun",
      args: [
        "-e",
        [
          opts.stderr ? `process.stderr.write(${JSON.stringify(opts.stderr)});` : "",
          opts.stdout ? `process.stdout.write(${JSON.stringify(opts.stdout)});` : "",
        ].join("\n"),
      ],
    }),
    createParser: () => textParser(opts.sessionId),
  };
}

/** Driver that emits N lines, each after delayMs, then exits. */
function timedLinesDriver(delayMs: number, lines: number): CliDriver {
  const script = `
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < ${lines}; i++) {
      await delay(${delayMs});
      process.stdout.write("line " + i + "\\n");
    }
  `;
  return {
    adapter: "claude-code",
    buildSpawn: () => ({ bin: "bun", args: ["-e", script] }),
    createParser: () => textParser(null),
  };
}

/** Driver that emits one line then goes silent for silenceMs. */
function silentAfterOneDriver(silenceMs: number): CliDriver {
  const script = `
    process.stdout.write("start\\n");
    await new Promise(r => setTimeout(r, ${silenceMs}));
  `;
  return {
    adapter: "claude-code",
    buildSpawn: () => ({ bin: "bun", args: ["-e", script] }),
    createParser: () => textParser(null),
  };
}

/** Driver that emits lines every intervalMs indefinitely (until killed). */
function infiniteProgressDriver(intervalMs: number): CliDriver {
  const script = `
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    while (true) {
      await delay(${intervalMs});
      process.stdout.write("tick\\n");
    }
  `;
  return {
    adapter: "claude-code",
    buildSpawn: () => ({ bin: "bun", args: ["-e", script] }),
    createParser: () => textParser(null),
  };
}

/** Driver that emits stdout chunks without newlines, then finishes with one newline. */
function chunkedProgressDriver(chunkDelayMs: number): CliDriver {
  const script = `
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    process.stdout.write("alpha");
    await delay(${chunkDelayMs});
    process.stdout.write("beta");
    await delay(${chunkDelayMs});
    process.stdout.write("\\n");
  `;
  return {
    adapter: "claude-code",
    buildSpawn: () => ({ bin: "bun", args: ["-e", script] }),
    createParser: () => textParser(null),
  };
}

function slowDriver(): CliDriver {
  return {
    adapter: "claude-code",
    buildSpawn: () => ({
      bin: "bun",
      args: ["-e", `setTimeout(() => process.stdout.write("late\\n"), 1000)`],
    }),
    createParser: () => textParser(null),
  };
}

describe("runTurn", () => {
  it("removes the daemon's Herdr location before applying the job context", () => {
    const env = childProcessEnv(
      {
        PATH: "/bin",
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "daemon-workspace",
        HERDR_PANE_ID: "daemon-pane",
        HERDR_TAB_ID: "daemon-tab",
        HERDR_STARTUP_CWD: "/daemon/cwd",
        HERDR_SESSION: "daemon-session",
        HERDR_SOCKET_PATH: "/shared/herdr.sock",
      },
      {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "job-workspace",
        HERDR_PANE_ID: "job-pane",
      },
    );

    expect(env.HERDR_WORKSPACE_ID).toBe("job-workspace");
    expect(env.HERDR_PANE_ID).toBe("job-pane");
    expect(env.HERDR_SESSION).toBeUndefined();
    expect(env.HERDR_TAB_ID).toBeUndefined();
    expect(env.HERDR_STARTUP_CWD).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBe("/shared/herdr.sock");
  });

  it("does not expose the daemon's Herdr location to a standalone job", () => {
    const env = childProcessEnv({
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "daemon-workspace",
      HERDR_PANE_ID: "daemon-pane",
    });

    expect(env.HERDR_ENV).toBeUndefined();
    expect(env.HERDR_WORKSPACE_ID).toBeUndefined();
    expect(env.HERDR_PANE_ID).toBeUndefined();
  });

  it("streams parsed events and synthesizes a result", async () => {
    const { events, outcome } = await runTurn(fakeDriver({ sessionId: "SID" }), spec, null, "go");
    expect(events.filter((e) => e.kind === "text").map((e) => (e as any).text)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(events.at(-1)).toEqual({ kind: "result", ok: true, text: "alpha\nbeta" });
    expect(outcome.sessionId).toBe("SID");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.finalText).toBe("alpha\nbeta");
  });

  it("falls back to resolveSessionId when the parser has none", async () => {
    const { outcome } = await runTurn(
      fakeDriver({ sessionId: null, resolve: "RESOLVED" }),
      spec,
      null,
      "go",
    );
    expect(outcome.sessionId).toBe("RESOLVED");
  });

  it("omits stderrTail when stderr is empty", async () => {
    const { outcome } = await runTurn(
      stderrDriver({ sessionId: null, stderr: "", stdout: "alpha\n" }),
      spec,
      null,
      "go",
    );
    expect(outcome.stderrTail).toBeUndefined();
  });

  it("retains raw stdout for startup failures that never reach the parser", async () => {
    const { outcome } = await runTurn(
      stderrDriver({
        sessionId: null,
        stderr: "",
        stdout: `HEAD_START|${"a".repeat(9000)}|CODEX_CONFIG_ERROR`,
      }),
      spec,
      null,
      "go",
    );
    expect(outcome.stdoutTail).toBeDefined();
    expect(outcome.stdoutTail!.length).toBeLessThanOrEqual(8192);
    expect(outcome.stdoutTail!).toContain("CODEX_CONFIG_ERROR");
    expect(outcome.stdoutTail!).not.toContain("HEAD_START");
  });

  it("retains only the bounded stderr tail", async () => {
    const { outcome } = await runTurn(
      stderrDriver({
        sessionId: null,
        stderr: `HEAD_START|${"a".repeat(9000)}|TAIL_MARKER`,
        stdout: "alpha\n",
      }),
      spec,
      null,
      "go",
    );
    expect(outcome.stderrTail).toBeDefined();
    expect(outcome.stderrTail!.length).toBeLessThanOrEqual(8192);
    expect(outcome.stderrTail!).toContain("TAIL_MARKER");
    expect(outcome.stderrTail!).not.toContain("HEAD_START");
  });

  it("kills a turn that exceeds the hard timeout (legacy timeoutMs)", async () => {
    const { events, outcome } = await runTurn(slowDriver(), spec, null, "go", { timeoutMs: 25 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.timeoutKind).toBe("hard");
    expect(outcome.exitCode).not.toBe(0);
    expect(events.at(-1)).toEqual({
      kind: "result",
      ok: false,
      text: "turn exceeded hard timeout 25ms",
    });
  });

  it("kills a turn that exceeds the hardTimeoutMs", async () => {
    const { events, outcome } = await runTurn(slowDriver(), spec, null, "go", {
      hardTimeoutMs: 25,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.timeoutKind).toBe("hard");
    expect(events.at(-1)?.kind).toBe("result");
    const result = events.at(-1) as Extract<(typeof events)[0], { kind: "result" }>;
    expect(result.text).toContain("hard timeout 25ms");
  });

  describe("AC-1: progress resets idle timer", () => {
    it("survives when lines arrive within the idle window", async () => {
      // 5 lines × 50ms apart = 250ms total; idleTimeout=250ms leaves room for process startup.
      const { outcome } = await runTurn(timedLinesDriver(50, 5), spec, null, "go", {
        idleTimeoutMs: 250,
        hardTimeoutMs: 2000,
      });
      expect(outcome.timedOut).toBeFalsy();
      expect(outcome.exitCode).toBe(0);
    });
  });

  describe("AC-2: idle timeout fires when progress stops", () => {
    it("kills the turn after idle threshold with no progress", async () => {
      // Emits 1 line then waits 400ms; idleTimeout=150ms → should fire
      const { events, outcome } = await runTurn(silentAfterOneDriver(400), spec, null, "go", {
        idleTimeoutMs: 150,
        hardTimeoutMs: 2000,
      });
      expect(outcome.timedOut).toBe(true);
      expect(outcome.timeoutKind).toBe("idle");
      expect(outcome.exitCode).not.toBe(0);
      const result = events.at(-1) as Extract<(typeof events)[0], { kind: "result" }>;
      expect(result.kind).toBe("result");
      expect(result.ok).toBe(false);
      expect(result.text).toContain("no progress for 150ms");
    });
  });

  describe("AC-3: hard timeout fires even with continuing progress", () => {
    it("kills the turn after hard limit regardless of progress", async () => {
      // Lines every 30ms; idleTimeout=300ms (never fires); hardTimeout=120ms → hard fires
      const { events, outcome } = await runTurn(infiniteProgressDriver(30), spec, null, "go", {
        idleTimeoutMs: 300,
        hardTimeoutMs: 120,
      });
      expect(outcome.timedOut).toBe(true);
      expect(outcome.timeoutKind).toBe("hard");
      expect(outcome.exitCode).not.toBe(0);
      const result = events.at(-1) as Extract<(typeof events)[0], { kind: "result" }>;
      expect(result.text).toContain("hard timeout 120ms");
    });
  });

  describe("AC-1 (onProgress callback)", () => {
    it("calls onProgress for stdout chunks and keeps idle timeouts alive while output continues", async () => {
      let progressCount = 0;
      const { outcome } = await runTurn(chunkedProgressDriver(60), spec, null, "go", {
        idleTimeoutMs: 250,
        hardTimeoutMs: 1000,
        onProgress: () => progressCount++,
      });
      expect(outcome.timedOut).toBeFalsy();
      expect(outcome.exitCode).toBe(0);
      expect(progressCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("AC-6: legacy AGVSR_TURN_TIMEOUT_MS path", () => {
    it("timeoutMs without hardTimeoutMs still triggers hard timeout", async () => {
      const { outcome } = await runTurn(slowDriver(), spec, null, "go", { timeoutMs: 25 });
      expect(outcome.timedOut).toBe(true);
      expect(outcome.timeoutKind).toBe("hard");
    });
  });

  describe("no timeout options", () => {
    it("completes normally when no timeout is set", async () => {
      const { outcome } = await runTurn(fakeDriver({ sessionId: null }), spec, null, "go");
      expect(outcome.timedOut).toBeFalsy();
      expect(outcome.exitCode).toBe(0);
    });
  });

  describe("usage accounting (D32)", () => {
    const usageDriver = (usage: TurnUsage | null): CliDriver => ({
      adapter: "claude-code",
      buildSpawn: () => ({ bin: "bun", args: ["-e", `process.stdout.write("alpha\\n")`] }),
      createParser: () => ({ ...textParser("S1"), usage: () => usage }),
    });

    it("copies the parser's usage onto the outcome", async () => {
      const usage: TurnUsage = {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        reasoning_tokens: null,
        cost_usd: 0.5,
      };
      const { outcome } = await runTurn(usageDriver(usage), spec, null, "go");
      expect(outcome.usage).toEqual(usage);
    });

    it("omits usage entirely when the parser reports none", async () => {
      const { outcome } = await runTurn(usageDriver(null), spec, null, "go");
      expect(outcome.usage).toBeUndefined();
    });

    it("omits usage for drivers that never implement the hook (agy)", async () => {
      const { outcome } = await runTurn(fakeDriver({ sessionId: null }), spec, null, "go");
      expect(outcome.usage).toBeUndefined();
    });
  });
});
