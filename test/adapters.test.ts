import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDriver } from "../src/adapters/claude.ts";
import { codexDriver } from "../src/adapters/codex.ts";
import { agyDriver } from "../src/adapters/agy.ts";
import { ADAPTER_BIN, driverFor } from "../src/adapters/index.ts";
import { agyMcpConfig, codexMcpConfigArgs } from "../src/adapters/mcp.ts";
import type { Adapter } from "../src/config/team.ts";
import { validateTeamModels } from "../src/adapters/validate.ts";
import { parseTeam } from "../src/config/team.ts";
import type { AgentSpec, CliDriver, TurnEvent } from "../src/adapters/types.ts";

const spec = (adapter: AgentSpec["adapter"]): AgentSpec => ({
  role: "implementation",
  adapter,
  model: "the-model",
  cwd: "/work/repo",
  systemPrompt: "SYSTEM-PROMPT",
  env: {
    AGVSR_SOCK: "/tmp/agvsr.sock",
    AGVSR_ROLE: "implementation",
    AGVSR_JOB_ID: "job-1",
    AGVSR_ALLOWED: "supervisor",
  },
});

const supervisorSpec = (): AgentSpec => ({
  ...spec("claude-code"),
  role: "supervisor",
});

const drain = (parser: { push(l: string): TurnEvent[] }, lines: string[]): TurnEvent[] =>
  lines.flatMap((l) => parser.push(l));

describe("claude driver", () => {
  it("builds a new-turn spawn (no --resume)", () => {
    const s = claudeDriver.buildSpawn(spec("claude-code"), null, "do it");
    expect(s.bin).toBe("claude");
    expect(s.bin).not.toMatch(/docker|chroot|wrapper/i);
    expect(s.args).toContain("--append-system-prompt");
    expect(s.args).toContain("SYSTEM-PROMPT");
    expect(s.args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(s.args).not.toContain("--dangerously-skip-permissions");
    expect(s.args).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "--model", "the-model"]),
    );
    expect(s.args).toEqual(expect.arrayContaining(["--mcp-config", "--strict-mcp-config"]));
    const config = JSON.parse(s.args[s.args.indexOf("--mcp-config") + 1]!);
    expect(config.mcpServers.agvsr.command).toBe("bun");
    expect(config.mcpServers.agvsr.args[0]).toBe("run");
    expect(config.mcpServers.agvsr.args[1]).toContain("src/mcp/shim.ts");
    expect(config.mcpServers.agvsr.env.AGVSR_ROLE).toBe("implementation");
    expect(s.args).not.toContain("--resume");
    expect(s.args.at(-1)).toBe("do it");
  });

  it("resumes by session id", () => {
    const s = claudeDriver.buildSpawn(spec("claude-code"), "SESS", "again");
    expect(s.bin).toBe("claude");
    expect(s.bin).not.toMatch(/docker|chroot|wrapper/i);
    expect(s.args).toEqual(expect.arrayContaining(["--resume", "SESS"]));
    expect(s.args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(s.args).not.toContain("--dangerously-skip-permissions");
  });

  it("keeps the supervisor destructive deny list in place", () => {
    const s = claudeDriver.buildSpawn(supervisorSpec(), null, "protect");
    expect(s.bin).toBe("claude");
    expect(s.args).toEqual(
      expect.arrayContaining([
        "--disallowed-tools",
        "Write,Edit,NotebookEdit,Bash,CronCreate,CronDelete,PushNotification,RemoteTrigger",
      ]),
    );
  });

  it("parses init/assistant/result into events", () => {
    const p = claudeDriver.createParser();
    const events = drain(p, [
      JSON.stringify({ type: "system", subtype: "init", session_id: "S1", model: "m" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi " },
            { type: "tool_use", name: "agvsr_send", input: { to: "supervisor" } },
          ],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", result: "hi", session_id: "S1" }),
    ]);
    expect(events).toEqual([
      { kind: "text", text: "hi " },
      { kind: "tool_use", name: "agvsr_send", input: { to: "supervisor" } },
      { kind: "result", ok: true, text: "hi" },
    ]);
    expect(p.sessionId()).toBe("S1");
    expect(p.finalText()).toBe("hi ");
  });

  it("scrapes token/cost accounting off the result event (D32)", () => {
    const p = claudeDriver.createParser();
    expect(p.usage?.()).toBeNull(); // nothing until the terminal event arrives
    drain(p, [
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "S1",
        total_cost_usd: 0.0159549,
        usage: {
          input_tokens: 10,
          output_tokens: 41,
          cache_read_input_tokens: 11609,
          cache_creation_input_tokens: 7014,
        },
      }),
    ]);
    // claude already reports input exclusive of cache reads, so it passes through as-is.
    expect(p.usage?.()).toEqual({
      input_tokens: 10,
      output_tokens: 41,
      cache_read_tokens: 11609,
      cache_write_tokens: 7014,
      reasoning_tokens: null,
      cost_usd: 0.0159549,
    });
  });

  it("reports null fields rather than zeros when the result event omits usage", () => {
    const p = claudeDriver.createParser();
    drain(p, [JSON.stringify({ type: "result", subtype: "success", result: "ok" })]);
    expect(p.usage?.()).toEqual({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      cost_usd: null,
    });
  });

  it("warns on obvious Claude shorthand model typos but not canonical IDs", () => {
    expect(claudeDriver.validateModel?.("opus-4.8")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("claude-"),
        hint: expect.stringContaining("claude-opus-4-8"),
      }),
    ]);
    expect(claudeDriver.validateModel?.("claude-opus-4-8")).toEqual([]);
    expect(claudeDriver.validateModel?.("claude-opus-4-8-20250514")).toEqual([]);
    expect(claudeDriver.validateModel?.("any-string-no-probe")).toEqual([]);
  });
});

describe("codex driver", () => {
  it("prepends the charter on a new turn, resumes by thread id", () => {
    const fresh = codexDriver.buildSpawn(spec("codex"), null, "do it");
    expect(fresh.bin).toBe("codex");
    expect(fresh.bin).not.toMatch(/docker|chroot|wrapper/i);
    expect(fresh.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(fresh.args).toEqual(expect.arrayContaining(["-C", "/work/repo"]));
    expect(fresh.args).toEqual(
      expect.arrayContaining(codexMcpConfigArgs({ cwd: "/work/repo", env: spec("codex").env })),
    );
    expect(fresh.args).toEqual(
      expect.arrayContaining(["-c", 'mcp_servers.agvsr.default_tools_approval_mode="approve"']),
    );
    expect(fresh.args).toEqual(
      expect.arrayContaining([
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-c",
        "sandbox_workspace_write.network_access=false",
      ]),
    );
    expect(fresh.args).not.toContain('sandbox_mode="danger-full-access"');
    expect(fresh.args).not.toContain('sandbox_permissions=["workspace-write"]');
    expect(fresh.args.at(-1)).toContain("SYSTEM-PROMPT");
    expect(fresh.args.at(-1)).toContain("do it");

    const resumed = codexDriver.buildSpawn(spec("codex"), "T1", "more");
    expect(resumed.bin).toBe("codex");
    expect(resumed.bin).not.toMatch(/docker|chroot|wrapper/i);
    expect(resumed.args.slice(0, 3)).toEqual(["exec", "resume", "T1"]);
    // `exec resume` has no `-C`/`--cd` flag; passing one is a hard CLI-parse error
    // (exit code 2, "unexpected argument '-C' found") before codex does anything.
    expect(resumed.args).not.toContain("-C");
    expect(resumed.args).toEqual(
      expect.arrayContaining(codexMcpConfigArgs({ cwd: "/work/repo", env: spec("codex").env })),
    );
    expect(resumed.args).toEqual(
      expect.arrayContaining([
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-c",
        "sandbox_workspace_write.network_access=false",
      ]),
    );
    expect(resumed.args).not.toContain('sandbox_mode="danger-full-access"');
    expect(resumed.args).not.toContain('sandbox_permissions=["workspace-write"]');
    expect(resumed.args).not.toContain("--sandbox"); // resume rejects it (S2)
  });

  it("allows writes to both the linked worktree's private git dir and the shared common dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worktree-"));
    const worktreeGitDir = join(dir, "main-repo-git-worktrees-entry");
    const commonDir = join(dir, "main-repo-dot-git");
    writeFileSync(join(dir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), `${commonDir}\n`);

    const s = codexDriver.buildSpawn({ ...spec("codex"), cwd: dir }, null, "do it");
    expect(s.args).toEqual(
      expect.arrayContaining([
        "-c",
        `sandbox_workspace_write.writable_roots=${JSON.stringify([worktreeGitDir, commonDir])}`,
      ]),
    );
  });

  it("allows writes to just the resolved git dir when there is no commondir file (non-linked repo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-worktree-"));
    const gitDir = join(dir, "some-git-dir");
    writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);

    const s = codexDriver.buildSpawn({ ...spec("codex"), cwd: dir }, null, "do it");
    expect(s.args).toEqual(
      expect.arrayContaining([
        "-c",
        `sandbox_workspace_write.writable_roots=${JSON.stringify([gitDir])}`,
      ]),
    );
  });

  it("falls back to an empty writable_roots when cwd has no linked-worktree .git file", () => {
    const s = codexDriver.buildSpawn(spec("codex"), null, "do it");
    expect(s.args).toEqual(
      expect.arrayContaining(["-c", "sandbox_workspace_write.writable_roots=[]"]),
    );
  });

  it("defaults network_access to false when the spec doesn't set networkAccess", () => {
    const s = codexDriver.buildSpawn(spec("codex"), null, "do it");
    expect(s.args).toEqual(
      expect.arrayContaining(["-c", "sandbox_workspace_write.network_access=false"]),
    );
  });

  it("opts in to network_access=true when the spec's networkAccess is true", () => {
    const s = codexDriver.buildSpawn({ ...spec("codex"), networkAccess: true }, null, "do it");
    expect(s.args).toEqual(
      expect.arrayContaining(["-c", "sandbox_workspace_write.network_access=true"]),
    );
  });

  it("parses thread/item/turn events", () => {
    const p = codexDriver.createParser();
    const events = drain(p, [
      JSON.stringify({ type: "thread.started", thread_id: "T9" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "BANANA" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ]);
    expect(events).toEqual([
      { kind: "text", text: "BANANA" },
      { kind: "result", ok: true, text: "BANANA" },
    ]);
    expect(p.sessionId()).toBe("T9");
  });

  it("normalizes cache-inclusive input tokens down to uncached input (D32)", () => {
    const p = codexDriver.createParser();
    drain(p, [
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 14832,
          cached_input_tokens: 11008,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 128,
        },
      }),
    ]);
    expect(p.usage?.()).toEqual({
      input_tokens: 14832 - 11008,
      output_tokens: 5,
      cache_read_tokens: 11008,
      cache_write_tokens: 0,
      reasoning_tokens: 128,
      cost_usd: null, // codex reports no cost at all
    });
  });

  it("never produces a negative input count if cached exceeds the reported total", () => {
    const p = codexDriver.createParser();
    drain(p, [
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 500 },
      }),
    ]);
    expect(p.usage?.()?.input_tokens).toBe(0);
  });
});

describe("agy driver", () => {
  it("prepends charter on new, uses --conversation on resume", () => {
    const fresh = agyDriver.buildSpawn(spec("agy"), null, "do it");
    expect(fresh.args.at(-1)).toContain("SYSTEM-PROMPT");
    const resumed = agyDriver.buildSpawn(spec("agy"), "C1", "more");
    expect(resumed.args).toEqual(expect.arrayContaining(["--conversation", "C1"]));
  });

  it("can generate the Antigravity mcp_config.json payload", () => {
    const config = JSON.parse(agyMcpConfig(spec("agy")));
    expect(config.mcpServers.agvsr.command).toBe("bun");
    expect(config.mcpServers.agvsr.args[1]).toContain("src/mcp/shim.ts");
    expect(config.mcpServers.agvsr.env.AGVSR_ALLOWED).toBe("supervisor");
  });

  it("treats stdout as plain text (no structured events)", () => {
    const p = agyDriver.createParser();
    const events = drain(p, ["BANANA"]);
    expect(events).toEqual([{ kind: "text", text: "BANANA" }]);
    expect(p.sessionId()).toBeNull();
    expect(p.finalText()).toBe("BANANA");
    // agy reports no accounting at all — the optional hook stays unimplemented (D32).
    expect(p.usage).toBeUndefined();
  });

  it("resolves a new conversation id by diffing the conversations dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-conv-"));
    process.env.AGVSR_AGY_CONV_DIR = dir;
    try {
      const before = agyDriver.probeSession!(spec("agy"));
      writeFileSync(join(dir, "new-uuid-123.db"), "");
      expect(agyDriver.resolveSessionId!(spec("agy"), before)).toBe("new-uuid-123");
    } finally {
      delete process.env.AGVSR_AGY_CONV_DIR;
    }
  });
});

describe("validateTeamModels", () => {
  it("returns only Claude findings for a mixed team", () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
  implementation: { adapter: codex, model: any-string-no-probe }
  qa: { adapter: agy, model: gemini-3-pro }
`);
    expect(validateTeamModels(team)).toEqual([
      expect.objectContaining({
        role: "supervisor",
        adapter: "claude-code",
        model: "opus-4.8",
        message: expect.stringContaining("Claude model IDs"),
        hint: expect.stringContaining("claude-opus-4-8"),
      }),
    ]);
  });

  it("returns one finding per role", () => {
    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
  design: { adapter: claude-code, model: sonnet-4.6 }
`);
    expect(validateTeamModels(team)).toEqual([
      expect.objectContaining({ role: "supervisor", adapter: "claude-code", model: "opus-4.8" }),
      expect.objectContaining({ role: "design", adapter: "claude-code", model: "sonnet-4.6" }),
    ]);
  });

  it("converts validator throws into warning findings", () => {
    const mutableClaude = claudeDriver as CliDriver & {
      validateModel?: (model: string) => { message: string; hint?: string }[];
    };
    const original = mutableClaude.validateModel;
    mutableClaude.validateModel = () => {
      throw new Error("boom");
    };

    try {
      const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: opus-4.8 }
`);
      expect(validateTeamModels(team)).toEqual([
        expect.objectContaining({
          role: "supervisor",
          adapter: "claude-code",
          model: "opus-4.8",
          message: expect.stringContaining("model validator threw: boom"),
        }),
      ]);
    } finally {
      mutableClaude.validateModel = original;
    }
  });

  it("keeps adapters without validateModel as no-op", () => {
    expect(codexDriver.validateModel).toBeUndefined();
    expect(agyDriver.validateModel).toBeUndefined();
  });
});

// Tripwire: agents must be spawned directly as their own CLI, never wrapped in
// another binary (docker, chroot, sandbox shims, etc.). If a future change wraps
// the spawn in a different process, the spawn `bin` changes and this test fails,
// surfacing the unexpected mechanism instead of letting it land silently.
describe("spawn binary tripwire", () => {
  const ADAPTERS: Adapter[] = ["claude-code", "codex", "agy"];

  for (const adapter of ADAPTERS) {
    const allowed = ADAPTER_BIN[adapter];

    it(`${adapter} spawns its own CLI (${allowed}) on a fresh turn`, () => {
      const s = driverFor(adapter).buildSpawn(spec(adapter), null, "do it");
      expect(s.bin).toBe(allowed);
    });

    it(`${adapter} spawns its own CLI (${allowed}) on resume`, () => {
      const s = driverFor(adapter).buildSpawn(spec(adapter), "session-1", "do it");
      expect(s.bin).toBe(allowed);
    });
  }

  it("never spawns a wrapper binary (docker/chroot/sh/env)", () => {
    const forbidden = new Set([
      "docker",
      "podman",
      "chroot",
      "sh",
      "bash",
      "env",
      "sudo",
      "nsenter",
    ]);
    const allowed = new Set(Object.values(ADAPTER_BIN));
    for (const adapter of ADAPTERS) {
      for (const sessionId of [null, "session-1"]) {
        const s = driverFor(adapter).buildSpawn(spec(adapter), sessionId, "do it");
        expect(forbidden.has(s.bin)).toBe(false);
        expect(allowed.has(s.bin)).toBe(true);
      }
    }
  });
});
