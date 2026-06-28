import { describe, expect, it } from "bun:test";
import { runTurn } from "../src/adapters/run.ts";
import type { AgentSpec, CliDriver, TurnParser } from "../src/adapters/types.ts";

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
    it("calls onProgress on each stdout line", async () => {
      let progressCount = 0;
      await runTurn(fakeDriver({ sessionId: null }), spec, null, "go", {
        onProgress: () => progressCount++,
      });
      // fakeDriver emits "alpha\n" and "beta\n"
      expect(progressCount).toBe(2);
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
});
