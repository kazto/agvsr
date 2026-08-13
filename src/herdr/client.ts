/**
 * herdr CLI wrapper (D29-D31). Talks to a running herdr server via the `herdr`
 * binary's own socket discovery — the caller process need not itself be inside
 * a herdr-managed pane, but must pass through the submitting pane's
 * HERDR_SESSION so the call reaches the right server (herdr/src/session.rs).
 *
 * Best-effort by design: any failure (binary missing, timeout, malformed JSON,
 * non-zero exit) resolves to null/void rather than throwing. herdr mode is an
 * enhancement over standalone mode, never a hard requirement — see
 * docs/design-herdr-integration.md D29.
 */

const DEFAULT_TIMEOUT_MS = 3000;

export interface HerdrClient {
  /** Resolve a `HERDR_WORKSPACE_ID` to its human-readable workspace label. */
  resolveWorkspaceName(workspaceId: string, session?: string | null): Promise<string | null>;
  /** Inject text (+ Enter) into the agent occupying `paneId`, fire-and-forget. */
  promptAgent(paneId: string, text: string, session?: string | null): Promise<void>;
  /** List live agents with enough identity to enforce workspace-bound delivery. */
  listAgents(session?: string | null): Promise<HerdrAgentListResult>;
  /** Prompt with a structured result for fail-closed workflows such as review requests. */
  promptAgentChecked(
    paneId: string,
    text: string,
    session?: string | null,
  ): Promise<HerdrPromptResult>;
}

export interface HerdrAgent {
  pane_id: string;
  workspace_id: string;
  agent: string;
  agent_status: string | null;
  cwd: string | null;
}

export type HerdrFailureCode = "unavailable" | "timeout" | "invalid_response";
export type HerdrAgentListResult =
  | { ok: true; agents: HerdrAgent[] }
  | { ok: false; code: HerdrFailureCode; message: string };
export type HerdrPromptResult =
  | { ok: true }
  | { ok: false; code: Exclude<HerdrFailureCode, "invalid_response">; message: string };

type SpawnFn = (
  args: string[],
  env: Record<string, string | undefined>,
) => ReturnType<typeof Bun.spawn>;

export interface CreateHerdrClientOptions {
  /** Binary name/path (default: "herdr", resolved via PATH). */
  bin?: string;
  timeoutMs?: number;
  /** Override subprocess spawning for tests. */
  spawn?: SpawnFn;
}

function herdrEnv(session?: string | null): Record<string, string | undefined> {
  const env = { ...process.env };
  if (session) {
    env.HERDR_SESSION = session;
  } else {
    delete env.HERDR_SESSION;
  }
  return env;
}

async function runHerdr(
  spawn: SpawnFn,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; timedOut: boolean } | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawn(args, env);
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // process may have already exited
    }
  }, timeoutMs);
  try {
    const stdoutText = new Response(proc.stdout as ReadableStream).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout: await stdoutText, timedOut };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface WorkspaceListResult {
  result?: { workspaces?: Array<{ workspace_id?: string; label?: string }> };
}

interface AgentListResult {
  result?: { agents?: unknown[] };
}

function parseAgent(value: unknown): HerdrAgent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.pane_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.agent !== "string"
  ) {
    return null;
  }
  return {
    pane_id: row.pane_id,
    workspace_id: row.workspace_id,
    agent: row.agent,
    agent_status: typeof row.agent_status === "string" ? row.agent_status : null,
    cwd: typeof row.cwd === "string" ? row.cwd : null,
  };
}

export function createHerdrClient(options: CreateHerdrClientOptions = {}): HerdrClient {
  const bin = options.bin ?? "herdr";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn: SpawnFn =
    options.spawn ??
    ((args, env) =>
      Bun.spawn([bin, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" }));

  return {
    async resolveWorkspaceName(workspaceId, session) {
      const result = await runHerdr(spawn, ["workspace", "list"], herdrEnv(session), timeoutMs);
      if (!result || result.exitCode !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as WorkspaceListResult;
        const match = parsed.result?.workspaces?.find((w) => w.workspace_id === workspaceId);
        return match?.label ?? null;
      } catch {
        return null;
      }
    },

    async promptAgent(paneId, text, session) {
      await runHerdr(spawn, ["agent", "prompt", paneId, text], herdrEnv(session), timeoutMs);
    },

    async listAgents(session) {
      const result = await runHerdr(spawn, ["agent", "list"], herdrEnv(session), timeoutMs);
      if (!result) return { ok: false, code: "unavailable", message: "herdr is unavailable" };
      if (result.timedOut)
        return { ok: false, code: "timeout", message: "herdr agent list timed out" };
      if (result.exitCode !== 0) {
        return { ok: false, code: "unavailable", message: "herdr agent list failed" };
      }
      try {
        const parsed = JSON.parse(result.stdout) as AgentListResult;
        if (!Array.isArray(parsed.result?.agents)) throw new Error("agents array missing");
        const agents: HerdrAgent[] = [];
        for (const value of parsed.result.agents) {
          const agent = parseAgent(value);
          if (!agent) {
            return {
              ok: false,
              code: "invalid_response",
              message: "herdr agent list returned an invalid agent record",
            };
          }
          agents.push(agent);
        }
        return { ok: true, agents };
      } catch {
        return {
          ok: false,
          code: "invalid_response",
          message: "herdr agent list returned invalid JSON",
        };
      }
    },

    async promptAgentChecked(paneId, text, session) {
      const result = await runHerdr(
        spawn,
        ["agent", "prompt", paneId, text],
        herdrEnv(session),
        timeoutMs,
      );
      if (!result) return { ok: false, code: "unavailable", message: "herdr is unavailable" };
      if (result.timedOut) return { ok: false, code: "timeout", message: "herdr prompt timed out" };
      if (result.exitCode !== 0) {
        return { ok: false, code: "unavailable", message: "herdr prompt failed" };
      }
      return { ok: true };
    },
  };
}
