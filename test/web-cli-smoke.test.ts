import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeam } from "../src/config/team.ts";
import { Client } from "../src/ipc/transport.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

let daemon: Daemon | null = null;

afterEach(async () => {
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
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
const delayMs = Number(server.env.AGVSR_FAKE_CLAUDE_DELAY_MS ?? "250");

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
].map((m) => JSON.stringify(m)).join("\\n") + "\\n";

proc.stdin.write(input);
proc.stdin.flush();
await Bun.sleep(delayMs);
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agvsr_complete", arguments: { job_id: jobId, result: "completed by fake claude through MCP" } } }) + "\\n");
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

function parseSetCookieHeaders(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    for (const chunk of header.split(/,(?=\s*__Host-agvsr_)/)) {
      const pair = chunk.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      out[name] = value;
    }
  }
  return out;
}

function responseSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""];
}

async function readStartup(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<{ endpoint: string; token: string }> {
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  const deadline = Date.now() + 10000;
  let endpoint = "";
  let token = "";
  let exitCode: number | null = null;
  proc.exited.then((code) => {
    exitCode = code;
  });
  let pending = reader.read();
  while (Date.now() < deadline && (!endpoint || !token)) {
    if (exitCode !== null) {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>)
        .text()
        .catch(() => "");
      throw new Error(
        `web CLI exited before printing startup details (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
    const race = await Promise.race([pending, Bun.sleep(50).then(() => ({ tick: true }) as const)]);
    if ("tick" in race) continue;
    if (race.done) break;
    buf += decoder.decode(race.value, { stream: true });
    pending = reader.read();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const endpointMatch = line.match(/agvsr web listening on\s+(\S+)/i);
      if (endpointMatch) endpoint = endpointMatch[1]!;
      const tokenMatch = line.match(/startup token:\s*(\S+)/i);
      if (tokenMatch) token = tokenMatch[1]!;
    }
  }
  if (!endpoint || !token) throw new Error("web CLI did not print startup details");
  return { endpoint, token };
}

describe("web cli smoke", () => {
  it("boots the real gateway, logs in, and serves read-only job data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-web-cli-"));
    const binDir = join(dir, "bin");
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const repo = join(dir, "repo");
    const fakeClaude = join(binDir, "claude");
    const oldPath = process.env.PATH ?? "";
    const oldTimeout = process.env.AGVSR_TURN_TIMEOUT_MS;
    const oldDelay = process.env.AGVSR_FAKE_CLAUDE_DELAY_MS;
    const oldStore = process.env.AGVSR_STORE;
    const oldSock = process.env.AGVSR_SOCK;
    mkdirSync(binDir);
    mkdirSync(repo);
    writeFileSync(fakeClaude, fakeClaudeScript());
    chmodSync(fakeClaude, 0o755);

    process.env.PATH = `${binDir}:${oldPath}`;
    process.env.AGVSR_TURN_TIMEOUT_MS = "5000";
    process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = "500";
    process.env.AGVSR_STORE = db;
    process.env.AGVSR_SOCK = sock;

    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);
    let webProc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      daemon = await startDaemon({ endpoint: sock, storeFile: db, team });

      webProc = Bun.spawn(
        ["bun", "run", "src/cli/agvsr.ts", "web", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AGVSR_STORE: db,
            AGVSR_SOCK: sock,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      try {
        const { endpoint, token } = await readStartup(webProc);
        const origin = new URL(endpoint).origin;

        const login = await fetch(new URL("/api/session/login", endpoint), {
          method: "POST",
          headers: {
            origin,
            "x-csrf-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ token }),
        });
        expect(login.status).toBe(200);
        const loginBody = (await login.json()) as { csrfToken: string };
        const cookies = parseSetCookieHeaders(responseSetCookies(login.headers));
        const sessionCookie = cookies["__Host-agvsr_session"];
        expect(sessionCookie).toBeTruthy();

        const client = await Client.connect(sock);
        try {
          const created = await client.request<{ job: Job }>("job.create", {
            goal: "web cli smoke",
            cwd: repo,
          });
          expect(created.ok).toBe(true);
          const jobId = created.ok ? created.result.job.id : "";

          await Bun.sleep(100);

          const list = await fetch(new URL("/api/jobs", endpoint), {
            headers: {
              cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${loginBody.csrfToken}`,
            },
          });
          expect(list.status).toBe(200);
          const listBody = (await list.json()) as {
            jobs: Array<{ job: { id: string; status: string }; display_state: string }>;
          };
          expect(listBody.jobs.some((row) => row.job.id === jobId)).toBe(true);

          const detail = await fetch(new URL(`/api/jobs/${jobId}`, endpoint), {
            headers: {
              cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${loginBody.csrfToken}`,
            },
          });
          expect(detail.status).toBe(200);
          const detailBody = (await detail.json()) as {
            job: { id: string };
            messages: Array<{ body: string }>;
          };
          expect(detailBody.job.id).toBe(jobId);
          expect(detailBody.messages.length).toBeGreaterThan(0);
        } finally {
          client.close();
        }

        webProc.kill();
        await webProc.exited;
      } finally {
        if (webProc) {
          webProc.kill();
          await webProc.exited.catch(() => {});
        }
      }
    } finally {
      process.env.PATH = oldPath;
      if (oldTimeout === undefined) delete process.env.AGVSR_TURN_TIMEOUT_MS;
      else process.env.AGVSR_TURN_TIMEOUT_MS = oldTimeout;
      if (oldDelay === undefined) delete process.env.AGVSR_FAKE_CLAUDE_DELAY_MS;
      else process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = oldDelay;
      process.env.AGVSR_STORE = oldStore;
      process.env.AGVSR_SOCK = oldSock;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
