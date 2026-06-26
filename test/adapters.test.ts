import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeDriver } from "../src/adapters/claude.ts";
import { codexDriver } from "../src/adapters/codex.ts";
import { agyDriver } from "../src/adapters/agy.ts";
import { agyMcpConfig, codexMcpConfigArgs } from "../src/adapters/mcp.ts";
import type { AgentSpec, TurnEvent } from "../src/adapters/types.ts";

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

const drain = (parser: { push(l: string): TurnEvent[] }, lines: string[]): TurnEvent[] =>
  lines.flatMap((l) => parser.push(l));

describe("claude driver", () => {
  it("builds a new-turn spawn (no --resume)", () => {
    const s = claudeDriver.buildSpawn(spec("claude-code"), null, "do it");
    expect(s.bin).toBe("claude");
    expect(s.args).toContain("--append-system-prompt");
    expect(s.args).toContain("SYSTEM-PROMPT");
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
    expect(s.args).toEqual(expect.arrayContaining(["--resume", "SESS"]));
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
});

describe("codex driver", () => {
  it("prepends the charter on a new turn, resumes by thread id", () => {
    const fresh = codexDriver.buildSpawn(spec("codex"), null, "do it");
    expect(fresh.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(fresh.args).toEqual(
      expect.arrayContaining(codexMcpConfigArgs({ cwd: "/work/repo", env: spec("codex").env })),
    );
    expect(fresh.args.at(-1)).toContain("SYSTEM-PROMPT");
    expect(fresh.args.at(-1)).toContain("do it");

    const resumed = codexDriver.buildSpawn(spec("codex"), "T1", "more");
    expect(resumed.args.slice(0, 3)).toEqual(["exec", "resume", "T1"]);
    expect(resumed.args).toEqual(
      expect.arrayContaining(codexMcpConfigArgs({ cwd: "/work/repo", env: spec("codex").env })),
    );
    expect(resumed.args).not.toContain("--sandbox"); // resume rejects it (S2)
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
