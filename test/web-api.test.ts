import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeam } from "../src/config/team.ts";
import { Client } from "../src/ipc/transport.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import { startWebGateway } from "../src/web/server.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

let daemon: Daemon | null = null;
let web: Awaited<ReturnType<typeof startWebGateway>> | null = null;

afterEach(async () => {
  if (web) {
    await web.close();
    web = null;
  }
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
});

function socketPath(endpoint: string): string {
  return new URL(endpoint).pathname;
}

async function gatewayFetch(
  endpoint: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost");
  const url = new URL(endpoint);
  if (url.protocol === "unix:") {
    return fetch(`http://localhost${path}`, {
      ...init,
      unix: socketPath(endpoint),
      headers,
    } as RequestInit & { unix: string });
  }
  return fetch(new URL(path, endpoint), {
    ...init,
    headers,
  });
}

function responseSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""];
}

function browserOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  return url.protocol === "unix:" ? "http://localhost" : url.origin;
}

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

describe("web api", () => {
  it("serves live job list and detail data without marking messages read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-web-api-"));
    const binDir = join(dir, "bin");
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const repo = join(dir, "repo");
    const fakeClaude = join(binDir, "claude");
    const oldPath = process.env.PATH ?? "";
    const oldTimeout = process.env.AGVSR_TURN_TIMEOUT_MS;
    const oldDelay = process.env.AGVSR_FAKE_CLAUDE_DELAY_MS;
    mkdirSync(binDir);
    mkdirSync(repo);
    writeFileSync(fakeClaude, fakeClaudeScript());
    chmodSync(fakeClaude, 0o755);

    process.env.PATH = `${binDir}:${oldPath}`;
    process.env.AGVSR_TURN_TIMEOUT_MS = "5000";
    process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = "500";

    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

    const oldStore = process.env.AGVSR_STORE;
    const oldSock = process.env.AGVSR_SOCK;
    process.env.AGVSR_STORE = db;
    process.env.AGVSR_SOCK = sock;

    try {
      daemon = await startDaemon({ endpoint: sock, storeFile: db, team });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);

      const login = await gatewayFetch(web.endpoint, "/api/session/login", {
        method: "POST",
        headers: {
          origin,
          "x-csrf-token": web.startupToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: web.startupToken }),
      });
      expect(login.status).toBe(200);
      const loginBody = (await login.json()) as { csrfToken: string };
      const cookies = parseSetCookieHeaders(responseSetCookies(login.headers));
      const sessionCookie = cookies["__Host-agvsr_session"];
      expect(sessionCookie).toBeTruthy();

      const c = await Client.connect(sock);
      try {
        const created = await c.request<{ job: Job }>("job.create", {
          goal: "web api smoke",
          cwd: repo,
        });
        expect(created.ok).toBe(true);
        const jobId = created.ok ? created.result.job.id : "";

        await Bun.sleep(100);

        const list = await gatewayFetch(web.endpoint, "/api/jobs", {
          headers: {
            cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${loginBody.csrfToken}`,
          },
        });
        expect(list.status).toBe(200);
        expect(list.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(list.headers.get("access-control-allow-origin")).toBeNull();
        const listBody = (await list.json()) as {
          jobs: Array<{
            job: { id: string; status: string; goal: string };
            runtime: { in_flight: boolean; idle_ms: number | null };
            display_state: string;
          }>;
        };
        const listed = listBody.jobs.find((row) => row.job.id === jobId);
        expect(listed).toBeTruthy();
        expect(
          ["in_flight", "idle", "possibly_stalled", "terminal"].includes(
            listed?.display_state ?? "",
          ),
        ).toBe(true);

        const before = await c.request<{ messages: Array<{ id: string; read_at: string | null }> }>(
          "msg.list",
          { job_id: jobId },
        );
        expect(before.ok).toBe(true);
        const beforeReadAt = before.ok ? before.result.messages.map((m) => m.read_at) : [];

        const detail = await gatewayFetch(web.endpoint, `/api/jobs/${jobId}`, {
          headers: {
            cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${loginBody.csrfToken}`,
          },
        });
        expect(detail.status).toBe(200);
        expect(detail.headers.get("content-security-policy")).toContain("default-src 'self'");
        const detailBody = (await detail.json()) as {
          job: { id: string; goal: string };
          messages: Array<{ body: string; read_at?: string | null }>;
          display_state: string;
        };
        expect(detailBody.job.id).toBe(jobId);
        expect(detailBody.messages.length).toBeGreaterThan(0);
        expect(
          ["in_flight", "idle", "possibly_stalled", "terminal"].includes(detailBody.display_state),
        ).toBe(true);

        const detailAgain = await gatewayFetch(web.endpoint, `/api/jobs/${jobId}`, {
          headers: {
            cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${loginBody.csrfToken}`,
          },
        });
        expect(detailAgain.status).toBe(200);

        const after = await c.request<{ messages: Array<{ id: string; read_at: string | null }> }>(
          "msg.list",
          { job_id: jobId },
        );
        expect(after.ok).toBe(true);
        const afterReadAt = after.ok ? after.result.messages.map((m) => m.read_at) : [];
        expect(afterReadAt).toEqual(beforeReadAt);
      } finally {
        c.close();
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
  });
});
