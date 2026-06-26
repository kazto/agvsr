/**
 * codex driver (resume-invoke, D8). `codex exec --json` for a new conversation,
 * `codex exec resume <thread_id> --json` to continue. codex exec has no system-
 * prompt flag, so the charter is prepended to the first turn's message (it then
 * persists in the session). Session id = the `thread.started` event's thread_id.
 * NOTE: `exec resume` does not accept --sandbox (set via -c in Phase 4).
 */
import { codexMcpConfigArgs } from "./mcp.ts";
import type { AgentSpec, CliDriver, SpawnSpec, TurnEvent, TurnParser } from "./types.ts";

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
}

export function withCharterPreamble(systemPrompt: string, message: string): string {
  return `${systemPrompt}\n\n---\n\n${message}`;
}

function createParser(): TurnParser {
  let session: string | null = null;
  let text = "";

  return {
    push(line: string): TurnEvent[] {
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
      } catch {
        return [];
      }

      if (ev.type === "thread.started" && ev.thread_id) {
        session = ev.thread_id;
        return [];
      }

      if (ev.type === "item.completed" && ev.item) {
        if (ev.item.type === "agent_message" && typeof ev.item.text === "string") {
          text += ev.item.text;
          return [{ kind: "text", text: ev.item.text }];
        }
        // command_execution / mcp_tool_call / reasoning / ... — observability only
        return [{ kind: "tool_use", name: ev.item.type ?? "unknown", input: ev.item }];
      }

      if (ev.type === "turn.completed") {
        return [{ kind: "result", ok: true, text }];
      }

      return [];
    },
    sessionId: () => session,
    finalText: () => text,
  };
}

export const codexDriver: CliDriver = {
  adapter: "codex",

  buildSpawn(spec: AgentSpec, sessionId: string | null, message: string): SpawnSpec {
    const common = [
      "--json",
      "--skip-git-repo-check",
      ...codexMcpConfigArgs({ cwd: spec.cwd, env: spec.env }),
      "-m",
      spec.model,
    ];
    if (sessionId) {
      return { bin: "codex", args: ["exec", "resume", sessionId, ...common, message] };
    }
    return {
      bin: "codex",
      args: ["exec", ...common, withCharterPreamble(spec.systemPrompt, message)],
    };
  },

  createParser,
};
