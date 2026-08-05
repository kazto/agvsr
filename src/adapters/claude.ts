/**
 * claude-code driver (resume-invoke, D8). Drives a turn via stream-json output
 * and `--resume <session_id>`; the system prompt goes in via --append-system-prompt.
 * Session id comes from the `system/init` (or `result`) event.
 */
import { claudeMcpConfig } from "./mcp.ts";
import { SUPERVISOR } from "../config/team.ts";
import type { AgentSpec, CliDriver, SpawnSpec, TurnEvent, TurnParser, TurnUsage } from "./types.ts";

// Hands-on tools the supervisor must never use directly (workers do the actual work).
const SUPERVISOR_DISALLOWED = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "CronCreate",
  "CronDelete",
  "PushNotification",
  "RemoteTrigger",
].join(",");

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
  result?: string;
  /** Only on the terminal `result` event (D32). */
  usage?: ClaudeUsage;
  total_cost_usd?: number;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

const CLAUDE_SHORTHAND_MODEL = /^(opus|sonnet|haiku)-\d+(?:\.\d+)?$/i;

function validateModel(model: string): { message: string; hint: string }[] {
  const match = CLAUDE_SHORTHAND_MODEL.exec(model);
  if (!match) return [];

  const family = match[1]!.toLowerCase();
  const version = model.slice(match[1]!.length + 1).replaceAll(".", "-");
  const canonical = `claude-${family}-${version}`;
  return [
    {
      message:
        "Claude model IDs usually include the `claude-` prefix and hyphenated version numbers.",
      hint: `Did you mean "${canonical}"?`,
    },
  ];
}

function createParser(): TurnParser {
  let session: string | null = null;
  let text = "";
  let usage: TurnUsage | null = null;

  return {
    push(line: string): TurnEvent[] {
      let ev: ClaudeEvent;
      try {
        ev = JSON.parse(line) as ClaudeEvent;
      } catch {
        return [];
      }

      if (ev.type === "system" && ev.subtype === "init") {
        if (ev.session_id) session = ev.session_id;
        return [];
      }

      if (ev.type === "assistant") {
        const out: TurnEvent[] = [];
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            text += block.text;
            out.push({ kind: "text", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            out.push({ kind: "tool_use", name: block.name, input: block.input });
          }
        }
        return out;
      }

      if (ev.type === "result") {
        if (ev.session_id) session = ev.session_id;
        // claude reports input_tokens exclusive of cache reads, so no adjustment.
        usage = {
          input_tokens: num(ev.usage?.input_tokens),
          output_tokens: num(ev.usage?.output_tokens),
          cache_read_tokens: num(ev.usage?.cache_read_input_tokens),
          cache_write_tokens: num(ev.usage?.cache_creation_input_tokens),
          reasoning_tokens: null, // not broken out by claude-code
          cost_usd: num(ev.total_cost_usd),
        };
        return [{ kind: "result", ok: ev.subtype === "success", text: ev.result }];
      }

      return [];
    },
    sessionId: () => session,
    finalText: () => text,
    usage: () => usage,
  };
}

export const claudeDriver: CliDriver = {
  adapter: "claude-code",
  validateModel,

  buildSpawn(spec: AgentSpec, sessionId: string | null, message: string): SpawnSpec {
    const args = [
      "-p",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      spec.model,
      "--append-system-prompt",
      spec.systemPrompt,
      "--mcp-config",
      claudeMcpConfig({ cwd: spec.cwd, env: spec.env }),
      "--strict-mcp-config",
    ];
    if (sessionId) args.push("--resume", sessionId);
    args.push(message);
    // Must come after the message: --disallowed-tools is variadic and consumes trailing positionals.
    if (spec.role === SUPERVISOR) {
      args.push("--disallowed-tools", SUPERVISOR_DISALLOWED);
    }
    return { bin: "claude", args };
  },

  createParser,
};
