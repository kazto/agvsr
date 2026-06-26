/**
 * agy (Antigravity) driver (resume-invoke, D8/D28). The degraded adapter:
 *   - no structured stdout — the whole reply is plain text (tool calls are only
 *     observable via the MCP shim, not here);
 *   - no self-chosen session id — agy mints a UUID stored as a per-conversation
 *     SQLite db, so we discover it by diffing the conversations dir after a turn;
 *   - no system-prompt flag — the charter is prepended to the first turn.
 * `--conversation <id>` can be slow to cold-start; harden with timeouts in Phase 4.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { AgentSpec, CliDriver, SessionProbe, SpawnSpec, TurnEvent, TurnParser } from "./types.ts";
import { withCharterPreamble } from "./codex.ts";

function conversationsDir(): string {
  return process.env.AGVSR_AGY_CONV_DIR ?? join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

function listConversationIds(): string[] {
  try {
    return readdirSync(conversationsDir())
      .filter((f) => f.endsWith(".db"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

function createParser(): TurnParser {
  let text = "";
  return {
    push(line: string): TurnEvent[] {
      text += text ? `\n${line}` : line;
      return [{ kind: "text", text: line }];
    },
    sessionId: () => null, // resolved out-of-band (resolveSessionId)
    finalText: () => text,
  };
}

export const agyDriver: CliDriver = {
  adapter: "agy",

  buildSpawn(spec: AgentSpec, sessionId: string | null, message: string): SpawnSpec {
    const model = ["--model", spec.model];
    if (sessionId) {
      return { bin: "agy", args: ["-p", "--conversation", sessionId, ...model, message] };
    }
    return { bin: "agy", args: ["-p", ...model, withCharterPreamble(spec.systemPrompt, message)] };
  },

  createParser,

  probeSession(): SessionProbe {
    return { known: listConversationIds() };
  },

  resolveSessionId(_spec: AgentSpec, before: SessionProbe): string | null {
    const seen = new Set(before.known);
    const created = listConversationIds().filter((id) => !seen.has(id));
    // Sequential v1 (D27): at most one new conversation per turn.
    return created[0] ?? null;
  },
};
