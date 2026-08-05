/**
 * Shared turn runner. Spawns the resume-invoke process the driver describes,
 * streams its stdout through the driver's parser, and resolves the session id
 * (out-of-band for adapters like agy that don't report it). IO lives here; all
 * per-CLI knowledge lives in the CliDriver.
 */
import type { AgentSpec, CliDriver, TurnEvent, TurnResult } from "./types.ts";

const STDERR_TAIL_CAP = 8192;

function appendTailChunk(chunks: Uint8Array[], chunk: Uint8Array, cap: number): number {
  if (chunk.length >= cap) {
    chunks.length = 0;
    chunks.push(chunk.slice(chunk.length - cap));
    return cap;
  }

  chunks.push(chunk);
  let bytes = chunks.reduce((sum, part) => sum + part.length, 0);
  while (bytes > cap) {
    const first = chunks[0];
    if (!first) break;
    const overflow = bytes - cap;
    if (first.length <= overflow) {
      chunks.shift();
      bytes -= first.length;
    } else {
      chunks[0] = first.slice(first.length - overflow);
      bytes -= overflow;
    }
  }

  return bytes;
}

export interface RunTurnOptions {
  /** Absolute upper bound. Kill regardless of progress (safety cap). */
  hardTimeoutMs?: number;
  /** No-progress upper bound. Kill if no stdout line arrives for this long. */
  idleTimeoutMs?: number;
  /** Backward compat: treated as hard fallback when hardTimeoutMs absent. */
  timeoutMs?: number;
  /** Called on each real stdout chunk arrival (Tier 2 progress tracking for daemon). */
  onProgress?: () => void;
  signal?: AbortSignal;
}

export async function runTurn(
  driver: CliDriver,
  spec: AgentSpec,
  sessionId: string | null,
  message: string,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const before = driver.probeSession?.(spec);
  const { bin, args, env } = driver.buildSpawn(spec, sessionId, message);
  const parser = driver.createParser();
  const events: TurnEvent[] = [];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new Error(
      `failed to spawn ${driver.adapter} executable ${JSON.stringify(bin)} in cwd ${JSON.stringify(spec.cwd)}: ${(err as Error).message}`,
    );
  }

  let timedOut = false;
  let timeoutKind: "hard" | "idle" | null = null;

  const hardMs = options.hardTimeoutMs ?? options.timeoutMs ?? null;
  const idleMs = options.idleTimeoutMs ?? null;

  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  if (hardMs) {
    hardTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        timeoutKind = "hard";
      }
      try {
        proc.kill();
      } catch {}
    }, hardMs);
  }

  const resetIdle = (): void => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        timeoutKind = "idle";
      }
      try {
        proc.kill();
      } catch {}
    }, idleMs);
  };

  if (idleMs) resetIdle();

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      proc.kill();
    } catch {}
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const decoder = new TextDecoder();
  let buf = "";
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) events.push(...parser.push(trimmed));
  };

  const stderrChunks: Uint8Array[] = [];
  let stderrBytes = 0;

  // Drain stderr concurrently to avoid the process blocking on a full stderr pipe.
  const stderrDrain = (async () => {
    for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) {
      options.onProgress?.();
      resetIdle();
      stderrBytes = appendTailChunk(stderrChunks, chunk, STDERR_TAIL_CAP);
    }
  })();

  for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    options.onProgress?.();
    resetIdle();
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      consume(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) {
    consume(buf); // trailing line without newline (e.g. agy)
  }

  const exitCode = await proc.exited;
  await stderrDrain;
  if (hardTimer) clearTimeout(hardTimer);
  if (idleTimer) clearTimeout(idleTimer);
  options.signal?.removeEventListener("abort", onAbort);

  // Synthesize a result for adapters that don't emit one (agy), or when the watchdog killed the turn.
  if (!events.some((e) => e.kind === "result")) {
    events.push({
      kind: "result",
      ok: exitCode === 0 && !timedOut && !aborted,
      text: timedOut
        ? timeoutKind === "idle"
          ? `turn made no progress for ${idleMs}ms`
          : `turn exceeded hard timeout ${hardMs}ms`
        : aborted
          ? "turn killed by user request"
          : parser.finalText(),
    });
  }

  let stderrTail: string | undefined;
  if (stderrBytes > 0) {
    const stderrTailBytes = new Uint8Array(stderrBytes);
    let offset = 0;
    for (const chunk of stderrChunks) {
      stderrTailBytes.set(chunk, offset);
      offset += chunk.length;
    }
    stderrTail = decoder.decode(stderrTailBytes);
  }

  const sessionId2 =
    parser.sessionId() ??
    (driver.resolveSessionId && before ? driver.resolveSessionId(spec, before) : null);

  // Present only if the CLI emitted its terminal accounting event. A killed or
  // timed-out turn usually never gets there, so usage is legitimately absent (D32).
  const usage = parser.usage?.() ?? null;

  return {
    events,
    outcome: {
      sessionId: sessionId2,
      finalText: parser.finalText(),
      ...(stderrTail ? { stderrTail } : {}),
      exitCode,
      timedOut,
      ...(timeoutKind ? { timeoutKind } : {}),
      ...(usage ? { usage } : {}),
    },
  };
}
