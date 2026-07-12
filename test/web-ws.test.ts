import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseTeam } from "../src/config/team.ts";
import { Client } from "../src/ipc/transport.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import { startWebGateway } from "../src/web/server.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { Job } from "../src/protocol.ts";

// Real daemon + gateway + WebSocket round-trips can exceed Bun's default 5s
// per-test timeout under load, causing flaky failures. Give them headroom.
setDefaultTimeout(20000);

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

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function openStream(
  url: string,
  headers: Record<string, string>,
): {
  ws: WebSocket;
  frames: Array<{ event: string; data: { id: string; body: string; job_id: string } }>;
  openedFlag: boolean;
  erroredFlag: boolean;
  closedFlag: boolean;
  opened: Promise<void>;
  closed: Promise<CloseEvent>;
  errored: Promise<Event>;
} {
  const frames: Array<{ event: string; data: { id: string; body: string; job_id: string } }> = [];
  let openedFlag = false;
  let erroredFlag = false;
  let closedFlag = false;
  let openResolve!: () => void;
  const opened = new Promise<void>((resolve) => {
    openResolve = resolve;
  });
  let closeResolve!: (ev: CloseEvent) => void;
  const closed = new Promise<CloseEvent>((resolve) => {
    closeResolve = resolve;
  });
  let errorResolve!: (ev: Event) => void;
  const errored = new Promise<Event>((resolve) => {
    errorResolve = resolve;
  });
  const ws = new WebSocket(url, { headers } as unknown as ConstructorParameters<
    typeof WebSocket
  >[1]);
  ws.addEventListener(
    "open",
    () => {
      openedFlag = true;
      openResolve();
    },
    { once: true },
  );
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      frames.push(JSON.parse(event.data));
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.addEventListener(
    "close",
    (event) => {
      closedFlag = true;
      closeResolve(event);
    },
    { once: true },
  );
  ws.addEventListener(
    "error",
    (event) => {
      erroredFlag = true;
      errorResolve(event);
    },
    { once: true },
  );
  return {
    ws,
    frames,
    get openedFlag() {
      return openedFlag;
    },
    get erroredFlag() {
      return erroredFlag;
    },
    get closedFlag() {
      return closedFlag;
    },
    opened,
    closed,
    errored,
  };
}

async function setupHarness(): Promise<{
  client: Client;
  web: Awaited<ReturnType<typeof startWebGateway>>;
  origin: string;
  cookieHeader: string;
  repo: string;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "agvsr-web-ws-"));
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
  process.env.AGVSR_TURN_TIMEOUT_MS = "5000";
  process.env.AGVSR_FAKE_CLAUDE_DELAY_MS = "500";
  process.env.AGVSR_STORE = db;
  process.env.AGVSR_SOCK = sock;
  process.env.AGVSR_WORKTREES = worktrees;

  const team = parseTeam(`
roles:
  supervisor: { adapter: claude-code, model: fake-model }
  implementation: { adapter: codex, model: fake-model }
`);

  try {
    daemon = await startDaemon({ endpoint: sock, storeFile: db, team });
    web = await startWebGateway({
      daemonEndpoint: sock,
      storeFile: db,
      host: "127.0.0.1",
      port: 0,
    });
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

    const client = await Client.connect(sock);
    return {
      client,
      web,
      origin,
      cookieHeader: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`,
      repo,
      cleanup: async () => {
        client.close();
        if (web) {
          await web.close();
          web = null;
        }
        if (daemon) {
          await daemon.close();
          daemon = null;
        }
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
      },
    };
  } catch (err) {
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
    throw err;
  }
}

describe("web websocket stream", () => {
  it("backfills existing messages, streams live messages once, and deduplicates ids", async () => {
    const harness = await setupHarness();
    try {
      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "web ws stream",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;

      await harness.client.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "backfill message",
      });

      const url = new URL(`/api/jobs/${jobId}/stream`, harness.web.endpoint).toString();
      const socket = openStream(url, {
        origin: harness.origin,
        cookie: harness.cookieHeader,
      });
      socket.ws.addEventListener("open", () => {
        void harness.client.request("msg.send", {
          from: "supervisor",
          job_id: jobId,
          to: "implementation",
          body: "live message",
        });
      });

      await socket.opened;
      await waitFor(
        () =>
          socket.frames.filter((frame) => frame.data.body === "backfill message").length === 1 &&
          socket.frames.filter((frame) => frame.data.body === "live message").length === 1,
      );

      const ids = socket.frames.map((frame) => frame.data.id);
      expect(new Set(ids).size).toBe(ids.length);

      socket.ws.close();
      await waitFor(() => socket.frames.some((frame) => frame.data.body === "live message"));
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects websocket upgrades without a valid session before open", async () => {
    const harness = await setupHarness();
    try {
      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "web ws no session",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;
      const path = `/api/jobs/${jobId}/stream`;

      const response = await gatewayFetch(harness.web.endpoint, path, {
        headers: {
          origin: harness.origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": randomUUID().replace(/-/g, "").slice(0, 24),
          "sec-websocket-version": "13",
        },
      });
      expect(response.status).toBe(401);

      const socket = openStream(new URL(path, harness.web.endpoint).toString(), {
        origin: harness.origin,
      } as Record<string, string>);
      await waitFor(() => socket.closedFlag || socket.erroredFlag, 1000);
      expect(socket.openedFlag).toBe(false);
      expect(socket.frames.length).toBe(0);
      socket.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects websocket upgrades with a bad origin before open", async () => {
    const harness = await setupHarness();
    try {
      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "web ws bad origin",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;
      const path = `/api/jobs/${jobId}/stream`;

      const response = await gatewayFetch(harness.web.endpoint, path, {
        headers: {
          origin: "http://evil.example",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": randomUUID().replace(/-/g, "").slice(0, 24),
          "sec-websocket-version": "13",
        },
      });
      expect(response.status).toBe(403);

      const socket = openStream(new URL(path, harness.web.endpoint).toString(), {
        origin: "http://evil.example",
        cookie: harness.cookieHeader,
      });
      await waitFor(() => socket.closedFlag || socket.erroredFlag, 1000);
      expect(socket.openedFlag).toBe(false);
      expect(socket.frames.length).toBe(0);
      socket.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("fans out the same live message to two authenticated clients", async () => {
    const harness = await setupHarness();
    try {
      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "web ws fanout",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;
      const url = new URL(`/api/jobs/${jobId}/stream`, harness.web.endpoint).toString();

      const one = openStream(url, {
        origin: harness.origin,
        cookie: harness.cookieHeader,
      });
      const two = openStream(url, {
        origin: harness.origin,
        cookie: harness.cookieHeader,
      });
      await Promise.all([one.opened, two.opened]);

      await harness.client.request("msg.send", {
        from: "supervisor",
        job_id: jobId,
        to: "implementation",
        body: "fanout live message",
      });

      await waitFor(
        () =>
          one.frames.filter((frame) => frame.data.body === "fanout live message").length === 1 &&
          two.frames.filter((frame) => frame.data.body === "fanout live message").length === 1,
      );

      one.ws.close();
      two.ws.close();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("global /api/jobs/stream WebSocket", () => {
  function openJobsStream(
    url: string,
    headers: Record<string, string>,
  ): {
    ws: WebSocket;
    frames: Array<{ event: string; data: Record<string, unknown> }>;
    openedFlag: boolean;
    closedFlag: boolean;
    erroredFlag: boolean;
    opened: Promise<void>;
    closed: Promise<CloseEvent>;
  } {
    const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
    let openedFlag = false;
    let closedFlag = false;
    let erroredFlag = false;
    let openResolve!: () => void;
    const opened = new Promise<void>((resolve) => {
      openResolve = resolve;
    });
    let closeResolve!: (ev: CloseEvent) => void;
    const closed = new Promise<CloseEvent>((resolve) => {
      closeResolve = resolve;
    });
    const ws = new WebSocket(url, { headers } as unknown as ConstructorParameters<
      typeof WebSocket
    >[1]);
    ws.addEventListener("open", () => {
      openedFlag = true;
      openResolve();
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        frames.push(JSON.parse(event.data) as { event: string; data: Record<string, unknown> });
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener("close", (event) => {
      closedFlag = true;
      closeResolve(event);
    });
    ws.addEventListener("error", () => {
      erroredFlag = true;
    });
    return {
      ws,
      frames,
      get openedFlag() {
        return openedFlag;
      },
      get closedFlag() {
        return closedFlag;
      },
      get erroredFlag() {
        return erroredFlag;
      },
      opened,
      closed,
    };
  }

  it("/api/jobs/stream delivers job.update to authenticated client", async () => {
    const harness = await setupHarness();
    try {
      const url = new URL("/api/jobs/stream", harness.web.endpoint).toString();
      const stream = openJobsStream(url, {
        origin: harness.origin,
        cookie: harness.cookieHeader,
      });
      await stream.opened;

      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "global stream test",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;

      await waitFor(() =>
        stream.frames.some(
          (f) => f.event === "job.update" && (f.data as { job_id: string }).job_id === jobId,
        ),
      );

      const updates = stream.frames.filter(
        (f) => f.event === "job.update" && (f.data as { job_id: string }).job_id === jobId,
      );
      expect(updates.length).toBeGreaterThan(0);
      const first = updates[0]!;
      expect((first.data as { status: string }).status).toBe("running");
      expect((first.data as { updated_at: string }).updated_at).toBeTruthy();

      stream.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("/api/jobs/stream fans out job.update to multiple clients", async () => {
    const harness = await setupHarness();
    try {
      const url = new URL("/api/jobs/stream", harness.web.endpoint).toString();
      const headers = { origin: harness.origin, cookie: harness.cookieHeader };
      const stream1 = openJobsStream(url, headers);
      const stream2 = openJobsStream(url, headers);
      await Promise.all([stream1.opened, stream2.opened]);

      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "fanout global stream",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;

      const hasUpdate = (stream: ReturnType<typeof openJobsStream>): boolean =>
        stream.frames.some(
          (f) => f.event === "job.update" && (f.data as { job_id: string }).job_id === jobId,
        );

      await waitFor(() => hasUpdate(stream1) && hasUpdate(stream2));

      expect(hasUpdate(stream1)).toBe(true);
      expect(hasUpdate(stream2)).toBe(true);

      stream1.ws.close();
      stream2.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("/api/jobs/:id/stream does not deliver job.update events", async () => {
    const harness = await setupHarness();
    try {
      const created = await harness.client.request<{ job: Job }>("job.create", {
        goal: "per-job isolation test",
        cwd: harness.repo,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const jobId = created.result.job.id;

      const perJobUrl = new URL(`/api/jobs/${jobId}/stream`, harness.web.endpoint).toString();
      const perJob = openStream(perJobUrl, {
        origin: harness.origin,
        cookie: harness.cookieHeader,
      });
      await perJob.opened;

      await waitFor(() => perJob.frames.length > 0, 2000);

      const jobUpdateFrames = perJob.frames.filter((f) => f.event === "job.update");
      expect(jobUpdateFrames.length).toBe(0);

      perJob.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("/api/jobs/stream rejects unauthenticated upgrades with 401", async () => {
    const harness = await setupHarness();
    try {
      const path = "/api/jobs/stream";

      const response = await gatewayFetch(harness.web.endpoint, path, {
        headers: {
          origin: harness.origin,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": randomUUID().replace(/-/g, "").slice(0, 24),
          "sec-websocket-version": "13",
        },
      });
      expect(response.status).toBe(401);

      const stream = openJobsStream(new URL(path, harness.web.endpoint).toString(), {
        origin: harness.origin,
      });
      await waitFor(() => stream.closedFlag || stream.erroredFlag, 1000);
      expect(stream.openedFlag).toBe(false);
      stream.ws.close();
    } finally {
      await harness.cleanup();
    }
  });

  it("/api/jobs/stream rejects bad-origin upgrades with 403", async () => {
    const harness = await setupHarness();
    try {
      const path = "/api/jobs/stream";

      const response = await gatewayFetch(harness.web.endpoint, path, {
        headers: {
          origin: "http://evil.example",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": randomUUID().replace(/-/g, "").slice(0, 24),
          "sec-websocket-version": "13",
        },
      });
      expect(response.status).toBe(403);

      const stream = openJobsStream(new URL(path, harness.web.endpoint).toString(), {
        origin: "http://evil.example",
        cookie: harness.cookieHeader,
      });
      await waitFor(() => stream.closedFlag || stream.erroredFlag, 1000);
      expect(stream.openedFlag).toBe(false);
      stream.ws.close();
    } finally {
      await harness.cleanup();
    }
  });
});
