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

  it("kills a turn that exceeds the timeout", async () => {
    const { events, outcome } = await runTurn(slowDriver(), spec, null, "go", { timeoutMs: 25 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
    expect(events.at(-1)).toEqual({ kind: "result", ok: false, text: "turn timed out after 25ms" });
  });
});
