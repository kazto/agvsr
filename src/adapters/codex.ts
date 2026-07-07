/**
 * codex driver (resume-invoke, D8). `codex exec --json` for a new conversation,
 * `codex exec resume <thread_id> --json` to continue. codex exec has no system-
 * prompt flag, so the charter is prepended to the first turn's message (it then
 * persists in the session). Session id = the `thread.started` event's thread_id.
 * NOTE: `exec resume` does not accept --sandbox (set via -c in Phase 4).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexMcpConfigArgs } from "./mcp.ts";
import type { AgentSpec, CliDriver, SpawnSpec, TurnEvent, TurnParser } from "./types.ts";

/**
 * A job's cwd is a linked git worktree: its `.git` is a file pointing at the real
 * per-worktree git dir under the main repo's `.git/worktrees/<id>` (HEAD/index/logs),
 * which lies outside cwd. That dir in turn has a `commondir` file pointing at the
 * *shared* git dir (objects/refs/packed-refs etc.), typically the main repo's `.git`
 * itself. Both live outside cwd. The codex sandbox denies writes outside its
 * writable_roots, so `git add`/`git commit` (index.lock, loose objects, ...) fail
 * there unless both dirs are allowed explicitly.
 */
function resolveGitWritableRoots(cwd: string): string[] {
  try {
    const gitFile = readFileSync(resolve(cwd, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(gitFile);
    const gitdir = match?.[1];
    if (!gitdir) return [];
    const worktreeGitDir = resolve(cwd, gitdir.trim());
    const roots = [worktreeGitDir];
    try {
      const commonDir = readFileSync(resolve(worktreeGitDir, "commondir"), "utf8").trim();
      if (commonDir) roots.push(resolve(worktreeGitDir, commonDir));
    } catch {
      // No commondir file: worktreeGitDir is already the (non-linked) git dir.
    }
    return roots;
  } catch {
    return [];
  }
}

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
    const writableRoots = resolveGitWritableRoots(spec.cwd);
    const common = [
      "--json",
      "--skip-git-repo-check",
      "-C",
      spec.cwd,
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
      "-c",
      "sandbox_workspace_write.network_access=false",
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
