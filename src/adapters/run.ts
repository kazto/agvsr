/**
 * Shared turn runner. Spawns the resume-invoke process the driver describes,
 * streams its stdout through the driver's parser, and resolves the session id
 * (out-of-band for adapters like agy that don't report it). IO lives here; all
 * per-CLI knowledge lives in the CliDriver.
 */
import type { AgentSpec, CliDriver, TurnEvent, TurnResult } from "./types.ts";

export async function runTurn(
  driver: CliDriver,
  spec: AgentSpec,
  sessionId: string | null,
  message: string,
): Promise<TurnResult> {
  const before = driver.probeSession?.(spec);
  const { bin, args, env } = driver.buildSpawn(spec, sessionId, message);
  const parser = driver.createParser();
  const events: TurnEvent[] = [];

  const proc = Bun.spawn([bin, ...args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let buf = "";
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) events.push(...parser.push(trimmed));
  };

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      consume(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) consume(buf); // trailing line without newline (e.g. agy)

  const exitCode = await proc.exited;

  // Synthesize a result for adapters that don't emit one (agy).
  if (!events.some((e) => e.kind === "result")) {
    events.push({ kind: "result", ok: exitCode === 0, text: parser.finalText() });
  }

  const sessionId2 =
    parser.sessionId() ??
    (driver.resolveSessionId && before ? driver.resolveSessionId(spec, before) : null);

  return {
    events,
    outcome: { sessionId: sessionId2, finalText: parser.finalText(), exitCode },
  };
}
