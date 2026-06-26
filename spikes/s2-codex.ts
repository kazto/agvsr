/**
 * Phase 0 / S2 (codex) — resume-invoke continuity + event shape.
 *
 * Goals:
 *   1. confirm `codex exec --json` event stream shape (find the session id field
 *      and what a tool/agent-message event looks like — needed for D8/D19).
 *   2. confirm `codex exec resume <id> <msg> --json` continues the conversation
 *      (memory recall across two separate processes).
 *
 * Exploratory: dumps every event's type + top-level keys for turn 1, extracts a
 * session id heuristically, then resumes and checks recall.
 */

type Ev = Record<string, any>;

async function runJsonl(args: string[]): Promise<{ events: Ev[]; raw: string; err: string; code: number }> {
  const proc = Bun.spawn(["codex", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [raw, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events: Ev[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* non-json line */
    }
  }
  return { events, raw, err, code };
}

function findSessionId(events: Ev[]): string | undefined {
  for (const e of events) {
    for (const k of ["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "id"]) {
      const v = e[k] ?? e?.msg?.[k] ?? e?.session?.[k];
      if (typeof v === "string" && /[0-9a-f-]{8,}/i.test(v)) return v;
    }
  }
  return undefined;
}

const COMMON = ["--json", "--sandbox", "read-only", "--skip-git-repo-check"];

console.log("=== TURN 1: codex exec --json (state a fact) ===");
const t1 = await runJsonl([
  "exec",
  ...COMMON,
  "Remember for later: the secret word is BANANA. Reply with just: OK",
]);
if (t1.code !== 0 && t1.events.length === 0) {
  console.error(`codex exited ${t1.code}\n[stderr]\n${t1.err}\n[stdout head]\n${t1.raw.slice(0, 800)}`);
  process.exit(1);
}

console.log(`  events: ${t1.events.length}`);
const seenTypes = new Map<string, number>();
for (const e of t1.events) {
  const ty = e.type ?? e.msg?.type ?? "(none)";
  seenTypes.set(ty, (seenTypes.get(ty) ?? 0) + 1);
}
console.log("  event types:", [...seenTypes.entries()].map(([t, n]) => `${t}×${n}`).join(", "));
console.log("  sample events (type + keys):");
for (const e of t1.events.slice(0, 12)) {
  console.log(`    type=${e.type ?? e.msg?.type} keys=[${Object.keys(e).join(",")}]${e.msg ? ` msg.keys=[${Object.keys(e.msg).join(",")}]` : ""}`);
}

const sid = findSessionId(t1.events);
console.log(`  → session id: ${sid ?? "(NOT FOUND — inspect raw below)"}`);
if (!sid) {
  console.log("  raw (first 1200 chars):\n" + t1.raw.slice(0, 1200));
  process.exit(2);
}

console.log("\n=== TURN 2: codex exec resume <id> (recall the fact) ===");
const t2 = await runJsonl(["exec", "resume", sid, ...COMMON, "What is the secret word I told you? Reply with just the word."]);
const lastText = t2.events
  .map((e) => e?.msg?.message ?? e?.message ?? e?.msg?.text ?? e?.text)
  .filter((x) => typeof x === "string")
  .join(" ");
console.log(`  events: ${t2.events.length}, joined text tail: ${JSON.stringify(lastText.slice(-200))}`);

const recalled = (lastText + t2.raw).toUpperCase().includes("BANANA");
console.log("\n--- S2 (codex) result ---");
console.log(recalled ? "PASS: codex exec resume continued the conversation." : "FAIL: recall not confirmed (inspect output).");
