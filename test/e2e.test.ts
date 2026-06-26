import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/ipc/transport.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job, Message } from "../src/protocol.ts";

const TEAM = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

let daemon: Daemon | null = null;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  while (cleanups.length) await cleanups.pop()!();
});

function fakeClaudeScript(): string {
  return `#!/usr/bin/env bun
const args = process.argv.slice(2);
const configIndex = args.indexOf("--mcp-config");
if (configIndex < 0) throw new Error("missing --mcp-config");
const config = JSON.parse(args[configIndex + 1]);
const server = config.mcpServers.agvsr;
const jobId = server.env.AGVSR_JOB_ID;
const sessionId = "fake-claude-session";

console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));

const proc = Bun.spawn([server.command, ...server.args], {
  cwd: server.cwd,
  env: { ...process.env, ...server.env },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const input = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agvsr_complete", arguments: { job_id: jobId, result: "completed by fake claude through MCP" } } },
].map((m) => JSON.stringify(m)).join("\\n") + "\\n";

proc.stdin.write(input);
proc.stdin.flush();

const decoder = new TextDecoder();
let buf = "";
let completed = false;
for await (const chunk of proc.stdout) {
  buf += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === 2) completed = true;
  }
  if (completed) break;
}
proc.kill();

console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: sessionId }));
`;
}

async function waitForJob(c: Client, id: string, status: Job["status"]): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const res = await c.request<{ job: Job }>("job.get", { id });
    if (res.ok && res.result.job.status === status) return res.result.job;
    await Bun.sleep(10);
  }
  throw new Error(`job ${id} did not reach ${status}`);
}

describe("agvsr E2E", () => {
  it("dispatches a job through the real daemon, adapter runner, fake claude CLI, and MCP shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-e2e-"));
    const binDir = join(dir, "bin");
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const oldPath = process.env.PATH ?? "";
    const oldTimeout = process.env.AGVSR_TURN_TIMEOUT_MS;

    mkdirSync(binDir);
    const fakeClaude = join(binDir, "claude");
    writeFileSync(fakeClaude, fakeClaudeScript());
    chmodSync(fakeClaude, 0o755);

    process.env.PATH = `${binDir}:${oldPath}`;
    process.env.AGVSR_TURN_TIMEOUT_MS = "5000";
    cleanups.push(() => {
      process.env.PATH = oldPath;
      if (oldTimeout === undefined) delete process.env.AGVSR_TURN_TIMEOUT_MS;
      else process.env.AGVSR_TURN_TIMEOUT_MS = oldTimeout;
      rmSync(dir, { recursive: true, force: true });
    });

    const { startDaemon } = await import("../src/daemon/daemon.ts");
    daemon = await startDaemon({ endpoint: sock, storeFile: db, team: TEAM });

    const c = await Client.connect(sock);
    try {
      const created = await c.request<{ job: Job }>("job.create", {
        goal: "complete via fake claude MCP",
        cwd: process.cwd(),
      });
      expect(created.ok).toBe(true);
      const id = created.ok ? created.result.job.id : "";

      const done = await waitForJob(c, id, "done");
      expect(done.status).toBe("done");

      const logs = await c.request<{ messages: Message[] }>("msg.list", { job_id: id });
      expect(logs.ok).toBe(true);
      expect(
        logs.ok &&
          logs.result.messages.some(
            (m) => m.kind === "completion" && m.body.includes("fake claude"),
          ),
      ).toBe(true);
    } finally {
      c.close();
    }
  });
});
