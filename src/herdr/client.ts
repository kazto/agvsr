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
}

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
): Promise<{ exitCode: number; stdout: string } | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = spawn(args, env);
  } catch {
    return null;
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // process may have already exited
    }
  }, timeoutMs);
  try {
    const stdoutText = new Response(proc.stdout as ReadableStream).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout: await stdoutText };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface WorkspaceListResult {
  result?: { workspaces?: Array<{ workspace_id?: string; label?: string }> };
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
  };
}
