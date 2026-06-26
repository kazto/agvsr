/**
 * Phase 0 / S1b — Resume-invoke adapter spike (claude-code).
 *
 * S1 showed `claude -p` stream-json does NOT serve a second turn on the same
 * process's stdin. The docs confirm persistent multi-turn stdin is an Agent SDK
 * feature; the CLI does multi-turn via --resume <session_id> (a fresh process
 * that continues a stored conversation).
 *
 * This spike tests whether claude can be driven exactly like codex/agy: each
 * turn = a one-shot process resuming a stored session. If conversation memory
 * survives across two separate invocations via --resume, all three adapters
 * collapse into ONE "resume-invoke" model.
 *
 * Pass criteria: turn 2 (a separate process) recalls a fact stated only in
 * turn 1 — proving session continuity via --resume.
 */

const MODEL = process.env.AGVSR_SPIKE_MODEL ?? "claude-haiku-4-5";

async function run(args: string[], input?: string): Promise<any> {
  const proc = Bun.spawn(["claude", ...args], {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`claude exited ${code}\n[stderr]\n${err}\n[stdout]\n${out}`);
  }
  return JSON.parse(out);
}

console.log("=== TURN 1: state a fact, capture session_id ===");
const t1 = await run([
  "-p",
  "Remember this for later: the secret word is BANANA. Reply with just: OK",
  "--output-format",
  "json",
  "--model",
  MODEL,
]);
const sessionId: string = t1.session_id;
console.log(`  session_id=${sessionId}`);
console.log(`  result=${JSON.stringify(t1.result)}`);

console.log("\n=== TURN 2: NEW process, --resume the session, ask for the fact ===");
const t2 = await run([
  "-p",
  "--resume",
  sessionId,
  "What is the secret word I told you? Reply with just the word.",
  "--output-format",
  "json",
  "--model",
  MODEL,
]);
console.log(`  session_id=${t2.session_id}`);
console.log(`  result=${JSON.stringify(t2.result)}`);

const recalled = String(t2.result ?? "").toUpperCase().includes("BANANA");
console.log("\n--- S1b result ---");
console.log(
  recalled
    ? "PASS: --resume continued the conversation across two separate processes.\n" +
        "      claude-code can use the SAME resume-invoke model as codex/agy."
    : "FAIL: turn 2 did not recall the fact; resume continuity not confirmed.",
);
