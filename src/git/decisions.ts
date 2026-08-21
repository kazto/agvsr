/**
 * Decision ledger for approved designs (D45).
 *
 * A recorded job ran three approve/reject rounds on one design, and each round
 * quietly undid decisions the human had already settled: an access TTL agreed
 * at 24h came back as 1h, an append-only scheme agreed with "do not change the
 * token format" came back embedding a family id. The supervisor caught every
 * one of them, so detection was never the problem. Convergence was: the rework
 * instruction asked for a revised design, the whole document got rewritten, and
 * settled paragraphs were re-rolled along with the rest.
 *
 * The fix is to make the approved text itself the record. Decisions carry
 * stable ids (`D-1`, `D-2`) — the documents in that job already used them —
 * and approval hashes each one. A revision may then change only the ids the
 * rework names; a resubmission that alters anything else is refused before the
 * supervisor ever reads it, so the round trip does not happen at all.
 *
 * Requiring ids is a real constraint on how designs are written. It is the
 * price of being able to say "this decision is the one that was approved"
 * mechanically rather than by re-reading 587 lines.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve, relative } from "node:path";

/** `D-1`, `- D-2:`, `### D-3 —` all count; the id must open the line. */
const DECISION_HEADING = /^\s*(?:[-*+]\s*)?(?:#{1,6}\s*)?(D-\d+)\b/;

/** Ids mentioned anywhere in prose, used to read a rework instruction's scope. */
const DECISION_MENTION = /\bD-\d+\b/g;

export function decisionLedgerEnabled(): boolean {
  const raw = process.env.AGVSR_DECISION_LEDGER;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

export interface ParsedDecision {
  id: string;
  /** SHA-256 of the decision's own text, normalized for trailing whitespace. */
  hash: string;
  /** First line, for error messages that have to be readable. */
  summary: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Split one document into decisions. A decision runs from its heading line to
 * the line before the next heading, so editing a paragraph changes that
 * decision's hash and nothing else's.
 */
export function parseDecisions(text: string): ParsedDecision[] {
  const lines = text.split("\n");
  const blocks = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const match = DECISION_HEADING.exec(line);
    if (match) {
      current = match[1]!;
      if (!blocks.has(current)) blocks.set(current, []);
    }
    if (current) blocks.get(current)!.push(line);
  }

  return [...blocks.entries()].map(([id, body]) => {
    // Trailing whitespace is not a decision change; reflowing one is.
    const normalized = body
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
    return {
      id,
      hash: hashText(normalized),
      summary: (body[0] ?? "").trim().slice(0, 120),
    };
  });
}

/** Resolve a ref to a readable path inside the worktree, or null. */
function refPath(worktree: string, ref: string): string | null {
  const abs = isAbsolute(ref) ? resolve(ref) : resolve(worktree, ref);
  const rel = relative(resolve(worktree), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return existsSync(abs) ? abs : null;
}

/**
 * Decisions across every ref a handoff cites. Ids are global to the handoff:
 * a design split over several files still yields one ledger, and the same id
 * appearing twice is treated as one decision made of both blocks.
 */
export function decisionsFromRefs(worktree: string, refs: string[]): ParsedDecision[] {
  const merged = new Map<string, ParsedDecision[]>();
  for (const ref of refs) {
    const path = refPath(worktree, ref);
    if (!path) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const decision of parseDecisions(text)) {
      const existing = merged.get(decision.id) ?? [];
      existing.push(decision);
      merged.set(decision.id, existing);
    }
  }

  return [...merged.entries()]
    .map(([id, parts]) => ({
      id,
      hash: parts.length === 1 ? parts[0]!.hash : hashText(parts.map((p) => p.hash).join("|")),
      summary: parts[0]!.summary,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Decision ids a message names — the scope a rework instruction authorises. */
export function mentionedDecisions(body: string): string[] {
  return [...new Set(body.match(DECISION_MENTION) ?? [])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export interface LedgerEntry {
  decision_id: string;
  hash: string;
  summary: string;
}

export interface Drift {
  id: string;
  summary: string;
  kind: "changed" | "removed";
}

/**
 * Approved decisions the resubmission altered without authorisation.
 * A decision that vanished counts: dropping one is a change of the same kind.
 */
export function outOfScopeDrift(
  approved: LedgerEntry[],
  resubmitted: ParsedDecision[],
  scope: string[],
): Drift[] {
  const allowed = new Set(scope);
  const now = new Map(resubmitted.map((d) => [d.id, d]));
  const drift: Drift[] = [];
  for (const entry of approved) {
    if (allowed.has(entry.decision_id)) continue;
    const current = now.get(entry.decision_id);
    if (!current) {
      drift.push({ id: entry.decision_id, summary: entry.summary, kind: "removed" });
    } else if (current.hash !== entry.hash) {
      drift.push({ id: entry.decision_id, summary: entry.summary, kind: "changed" });
    }
  }
  return drift;
}

export function driftMessage(drift: Drift[], scope: string[]): string {
  const rows = drift
    .map(
      (d) => `  ${d.id}  ${d.kind === "removed" ? "(削除された)" : "(変更された)"}  ${d.summary}`,
    )
    .join("\n");
  const scopeText = scope.length > 0 ? scope.join(", ") : "(なし)";
  return [
    `これらの決定は承認済みで、今回の改訂スコープ (${scopeText}) に含まれません。`,
    `承認時の内容に戻してから再提出してください。`,
    ``,
    rows,
    ``,
    `改訂スコープを広げる必要がある場合は、全文を書き直すのではなく、`,
    `人間に再承認を求めてください。`,
  ].join("\n");
}

/** The frozen-decision list appended to a rework instruction. */
export function frozenNotice(approved: LedgerEntry[], scope: string[]): string {
  const allowed = new Set(scope);
  const frozen = approved.filter((e) => !allowed.has(e.decision_id));
  if (frozen.length === 0) return "";
  return [
    ``,
    `--- agvsr: 承認済みにつき変更禁止 ---`,
    `以下は人間が承認済みの決定です。今回の改訂対象は ${scope.join(", ")} のみで、`,
    `下記は現状のまま残してください。全文を書き直さず、差分のみを変更すること。`,
    ...frozen.map((e) => `  ${e.decision_id}  ${e.summary}`),
    `--------------------------------------`,
  ].join("\n");
}

export { join as joinPath };
