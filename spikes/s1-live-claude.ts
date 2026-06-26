/**
 * Phase 0 / S1 — Live adapter spike (claude-code).
 *
 * Goal: prove the D8 "live adapter" assumption — a single claude-code process,
 * driven in stream-json mode, stays alive across turns and accepts a NEW user
 * turn injected on stdin (the wake-by-stdin mechanism of D7).
 *
 * What it does:
 *   1. spawn `claude -p --input-format stream-json --output-format stream-json`
 *   2. inject turn 1, read structured events until the turn's `result`
 *   3. WITHOUT respawning, inject turn 2 on the same process's stdin
 *   4. read events until the second `result`
 *   5. close stdin, confirm the process was alive the whole time
 *
 * Pass criteria: two distinct assistant replies from ONE process, the second
 * obtained purely by writing to stdin after the first turn finished.
 */

const MODEL = process.env.AGVSR_SPIKE_MODEL ?? "claude-haiku-4-5";

type StreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  result?: string;
  [k: string]: unknown;
};

function userTurn(text: string): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

function assistantText(ev: StreamEvent): string {
  const parts = ev.message?.content ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

const proc = Bun.spawn(
  [
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    MODEL,
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

const decoder = new TextDecoder();
let buf = "";

// Async iterator over parsed stream-json events from stdout.
async function* events(): AsyncGenerator<StreamEvent> {
  // @ts-expect-error Bun stdout is an async-iterable ReadableStream of Uint8Array
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as StreamEvent;
      } catch {
        console.log("  [non-json]", line);
      }
    }
  }
}

const evIter = events();

async function sendTurn(label: string, text: string): Promise<void> {
  console.log(`\n=== ${label}: inject -> ${JSON.stringify(text)} (pid alive: ${proc.killed ? "NO" : "yes"}) ===`);
  proc.stdin.write(userTurn(text));
  proc.stdin.flush();
  for await (const ev of evIter) {
    if (ev.type === "system" && ev.subtype === "init") {
      console.log(`  [init] session=${ev.session_id} model=${(ev as any).model}`);
    } else if (ev.type === "assistant") {
      const t = assistantText(ev).trim();
      if (t) console.log(`  [assistant] ${t}`);
    } else if (ev.type === "result") {
      console.log(`  [result] ${ev.subtype ?? ""} ${JSON.stringify(ev.result ?? "")}`);
      return; // turn complete; process should still be alive
    }
  }
  throw new Error(`${label}: stream ended before a result (process exited?)`);
}

const exited = proc.exited.then((code) => {
  console.log(`\n[process exited] code=${code}`);
});

try {
  await sendTurn("TURN 1", "Reply with exactly the single token: READY1");
  const aliveAfter1 = !proc.killed;
  await sendTurn("TURN 2", "Reply with exactly the single token: READY2");
  const aliveAfter2 = !proc.killed;

  console.log("\n--- S1 result ---");
  console.log("alive after turn 1:", aliveAfter1);
  console.log("alive after turn 2:", aliveAfter2);
  console.log(
    aliveAfter1 && aliveAfter2
      ? "PASS: one process served two stdin-injected turns (live adapter viable)."
      : "FAIL: process did not persist across turns.",
  );
} catch (err) {
  console.error("\nS1 ERROR:", (err as Error).message);
  const stderr = await new Response(proc.stderr).text();
  if (stderr.trim()) console.error("[stderr]\n" + stderr);
} finally {
  proc.stdin.end();
  // give it a moment to flush/exit, then ensure cleanup
  await Promise.race([exited, Bun.sleep(3000)]);
  if (!proc.killed) proc.kill();
}
