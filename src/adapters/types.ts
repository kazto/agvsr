/**
 * Adapter layer types (D8). All three CLIs are driven by the same resume-invoke
 * model: a turn = spawn `<cli> ... resume <session> <message>`, stream structured
 * events, exit. A `CliDriver` isolates the per-CLI differences (argv + parsing);
 * the shared runner (`run.ts`) owns the IO.
 *
 * Tool calls (agvsr_send/escalate/complete/fail) are NOT routed from these events
 * — they travel the MCP shim -> daemon channel (D19). `tool_use` events here are
 * observability only (for the watchdog/audit).
 */
import type { Adapter } from "../config/team.ts";

/** Everything needed to drive one agent's turns. */
export interface AgentSpec {
  role: string;
  adapter: Adapter;
  model: string;
  /** Shared job workspace (D20). */
  cwd: string;
  /** Composed charter (scaffold + role charter), injected as the system prompt (D25). */
  systemPrompt: string;
  /** Daemon-provided runtime environment, mainly for the MCP stdio shim (D19). */
  env?: Record<string, string>;
}

/** Structured events surfaced from a turn (observability; routing is via MCP). */
export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "result"; ok: boolean; text?: string };

/** Warning-only model validation emitted by adapter heuristics. */
export interface ModelValidationWarning {
  message: string;
  hint?: string;
}

export interface TurnOutcome {
  /** The (possibly newly created) session id to resume next turn. */
  sessionId: string | null;
  /** The agent's final assistant text for this turn. */
  finalText: string;
  /** Bounded stderr tail kept for diagnostics/classification. */
  stderrTail?: string;
  exitCode: number;
  /** True when the deterministic runtime watchdog killed the turn (D14). */
  timedOut?: boolean;
  /** Which timeout fired: "hard" for wall-clock limit, "idle" for no-progress limit. */
  timeoutKind?: "hard" | "idle";
}

/** Result of driving one turn: collected events + the outcome. */
export interface TurnResult {
  events: TurnEvent[];
  outcome: TurnOutcome;
}

/** How to spawn one turn for a given CLI. */
export interface SpawnSpec {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

/** Incrementally parses a CLI's stdout into events + the turn's session id. */
export interface TurnParser {
  /** Feed one stdout line; returns any events it produced. */
  push(line: string): TurnEvent[];
  /** Best-effort session id discovered so far (e.g. from an init/thread event). */
  sessionId(): string | null;
  /** Accumulated assistant text. */
  finalText(): string;
}

/** Per-CLI driver: the only place adapter-specific knowledge lives. */
export interface CliDriver {
  readonly adapter: Adapter;
  /** Warning-only, heuristic model validation. Missing means no warnings. */
  validateModel?(model: string): ModelValidationWarning[];
  /** Build the spawn for a turn. `sessionId === null` starts a new conversation. */
  buildSpawn(spec: AgentSpec, sessionId: string | null, message: string): SpawnSpec;
  /** Fresh parser for one turn's stdout. */
  createParser(): TurnParser;
  /**
   * Some CLIs (agy) don't report their session id on stdout. After a turn, the
   * runner calls this to resolve it out-of-band (e.g. newest conversation db).
   * Return null to keep whatever the parser found.
   */
  resolveSessionId?(spec: AgentSpec, before: SessionProbe): string | null;
  /** Snapshot used by resolveSessionId to detect what the turn created. */
  probeSession?(spec: AgentSpec): SessionProbe;
}

export interface SessionProbe {
  /** Conversation ids known before the turn (adapter-specific). */
  known: string[];
}
