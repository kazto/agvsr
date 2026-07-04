import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeam } from "../src/config/team.ts";
import { Client } from "../src/ipc/transport.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import { startWebGateway } from "../src/web/server.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

setDefaultTimeout(30000);

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

function responseSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return getSetCookie ? getSetCookie.call(headers) : [headers.get("set-cookie") ?? ""];
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

function browserOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  return url.protocol === "unix:" ? "http://localhost" : url.origin;
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
      unix: new URL(endpoint).pathname,
      headers,
    } as RequestInit & { unix: string });
  }
  return fetch(new URL(path, endpoint), {
    ...init,
    headers,
  });
}

function waitForStatus(
  endpoint: string,
  cookieHeader: string,
  jobId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      const res = await gatewayFetch(endpoint, `/api/jobs/${encodeURIComponent(jobId)}`, {
        headers: { cookie: cookieHeader },
      });
      if (res.status !== 200) {
        reject(new Error(`unexpected status ${res.status}`));
        return;
      }
      const body = (await res.json()) as {
        job: Job;
        runtime: { in_flight: boolean };
      };
      if (body.job.status === expected) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${expected}, last status ${body.job.status}`));
        return;
      }
      setTimeout(() => void tick().catch(reject), 50);
    };
    void tick();
  });
}

describe("web ops", () => {
  it("creates, tells, stops, and kills jobs through the real web gateway with CSRF and audits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-web-ops-"));
    const binDir = join(dir, "bin");
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const repo = join(dir, "repo");
    const worktrees = join(dir, "worktrees");
    const fakeClaude = join(binDir, "claude");
    const oldPath = process.env.PATH ?? "";
    const oldTimeout = process.env.AGVSR_TURN_TIMEOUT_MS;
    const oldDelay = process.env.AGVSR_FAKE_CLAUDE_DELAY_MS;
    const oldStore = process.env.AGVSR_STORE;
    const oldSock = process.env.AGVSR_SOCK;
    const oldWorktrees = process.env.AGVSR_WORKTREES;
    mkdirSync(binDir);
    mkdirSync(repo);
    mkdirSync(worktrees);
    writeFileSync(fakeClaude, fakeClaudeScript());
    chmodSync(fakeClaude, 0o755);

    process.env.PATH = `${binDir}:${oldPath}`;
    process.env.AGVSR_TURN_TIMEOUT_MS = "10000";
    process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = "3000";
    process.env.AGVSR_STORE = db;
    process.env.AGVSR_SOCK = sock;
    process.env.AGVSR_WORKTREES = worktrees;

    const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
`);

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
      const csrfCookie = cookies["__Host-agvsr_csrf"] ?? loginBody.csrfToken;
      expect(sessionCookie).toBeTruthy();
      const cookieHeader = `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`;

      const client = await Client.connect(sock);
      try {
        const createTell = await gatewayFetch(web.endpoint, "/api/jobs", {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ goal: "tell job", cwd: repo }),
        });
        expect(createTell.status).toBe(201);
        const createTellBody = (await createTell.json()) as {
          job: { job: Job; runtime: { in_flight: boolean } };
        };
        const tellJobId = createTellBody.job.job.id;
        await waitForStatus(web.endpoint, cookieHeader, tellJobId, "running");

        const tellBody = "x".repeat(512);
        const tell = await gatewayFetch(web.endpoint, `/api/jobs/${tellJobId}/tell`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: tellBody }),
        });
        expect(tell.status).toBe(200);
        const tellResponse = (await tell.json()) as { queued: true; message: { body: string } };
        expect(tellResponse.message.body).toBe(tellBody);
        const tellMessages = await client.request<{ messages: Array<{ body: string }> }>(
          "msg.list",
          { job_id: tellJobId },
        );
        expect(tellMessages.ok).toBe(true);
        if (!tellMessages.ok) throw new Error("msg.list failed");
        expect(tellMessages.result.messages.some((message) => message.body === tellBody)).toBe(
          true,
        );

        const createStop = await gatewayFetch(web.endpoint, "/api/jobs", {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ goal: "stop job", cwd: repo }),
        });
        expect(createStop.status).toBe(201);
        const stopJobId = ((await createStop.json()) as { job: { job: Job } }).job.job.id;
        await waitForStatus(web.endpoint, cookieHeader, stopJobId, "running");

        const stop = await gatewayFetch(web.endpoint, `/api/jobs/${stopJobId}/stop`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(stop.status).toBe(200);
        await waitForStatus(web.endpoint, cookieHeader, stopJobId, "failed");

        const createKill = await gatewayFetch(web.endpoint, "/api/jobs", {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ goal: "kill job", cwd: repo }),
        });
        expect(createKill.status).toBe(201);
        const killJobId = ((await createKill.json()) as { job: { job: Job } }).job.job.id;
        await waitForStatus(web.endpoint, cookieHeader, killJobId, "running");

        const kill = await gatewayFetch(web.endpoint, `/api/jobs/${killJobId}/kill`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": csrfCookie,
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(kill.status).toBe(200);
        await waitForStatus(web.endpoint, cookieHeader, killJobId, "interrupted");

        const missingCsrf = await gatewayFetch(web.endpoint, "/api/jobs", {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "content-type": "application/json",
          },
          body: JSON.stringify({ goal: "no csrf", cwd: repo }),
        });
        expect(missingCsrf.status).toBe(403);

        const wrongCsrf = await gatewayFetch(web.endpoint, `/api/jobs/${tellJobId}/tell`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieHeader,
            "x-csrf-token": "wrong",
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "denied" }),
        });
        expect(wrongCsrf.status).toBe(403);

        const unauthenticated = await gatewayFetch(web.endpoint, "/api/jobs", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ goal: "no session", cwd: repo }),
        });
        expect(unauthenticated.status).toBe(401);

        const sqlite = new Database(db);
        const rows = sqlite
          .query(
            `SELECT operation, status, job_id, error_code, request_summary
             FROM web_operation_audit
             ORDER BY id ASC`,
          )
          .all() as Array<{
          operation: string;
          status: string;
          job_id: string | null;
          error_code: string | null;
          request_summary: string;
        }>;
        sqlite.close();

        expect(rows.some((row) => row.operation === "job.create" && row.status === "success")).toBe(
          true,
        );
        expect(rows.some((row) => row.operation === "job.tell" && row.status === "success")).toBe(
          true,
        );
        expect(rows.some((row) => row.operation === "job.stop" && row.status === "success")).toBe(
          true,
        );
        expect(rows.some((row) => row.operation === "job.kill" && row.status === "success")).toBe(
          true,
        );
        expect(
          rows.some(
            (row) =>
              row.operation === "job.create" &&
              row.status === "failure" &&
              row.error_code === "csrf_mismatch",
          ),
        ).toBe(true);
        expect(
          rows.some(
            (row) =>
              row.operation === "job.tell" &&
              row.status === "failure" &&
              row.error_code === "csrf_mismatch",
          ),
        ).toBe(true);
        const tellAudit = rows.find(
          (row) => row.operation === "job.tell" && row.status === "success",
        );
        expect(tellAudit).toBeTruthy();
        expect(tellAudit?.request_summary.includes(tellBody)).toBe(false);
        expect(tellAudit?.request_summary).toContain('"body_preview"');
      } finally {
        client.close();
      }
    } finally {
      process.env.PATH = oldPath;
      if (oldTimeout === undefined) delete process.env.AGVSR_TURN_TIMEOUT_MS;
      else process.env.AGVSR_TURN_TIMEOUT_MS = oldTimeout;
      if (oldDelay === undefined) delete process.env.AGVSR_FAKE_CLAUDE_DELAY_MS;
      else process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = oldDelay;
      if (oldStore === undefined) delete process.env.AGVSR_STORE;
      else process.env.AGVSR_STORE = oldStore;
      if (oldSock === undefined) delete process.env.AGVSR_SOCK;
      else process.env.AGVSR_SOCK = oldSock;
      if (oldWorktrees === undefined) delete process.env.AGVSR_WORKTREES;
      else process.env.AGVSR_WORKTREES = oldWorktrees;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
