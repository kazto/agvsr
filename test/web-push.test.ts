import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebAuthStore } from "../src/web/auth-store.ts";
import { sendPush, deriveEncryptionKeys } from "../src/web/push.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import { startWebGateway } from "../src/web/server.ts";
import { parseTeam } from "../src/config/team.ts";
import type { Daemon } from "../src/daemon/daemon.ts";
import type { PushPayload } from "../src/hooks.ts";
import type { PushSubscriptionRow } from "../src/web/auth-store.ts";

setDefaultTimeout(30000);

let daemonInst: Daemon | null = null;
let web: Awaited<ReturnType<typeof startWebGateway>> | null = null;

afterEach(async () => {
  if (web) {
    await web.close();
    web = null;
  }
  if (daemonInst) {
    await daemonInst.close();
    daemonInst = null;
  }
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agvsr-push-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true });
  } catch {}
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
  return fetch(new URL(path, endpoint), { ...init, headers });
}

interface LoginResult {
  cookieHeader: string;
  csrfToken: string;
  sessionCookie: string;
  csrfCookie: string;
}

function responseSetCookies(headers: Headers): string[] {
  const fn = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return fn ? fn.call(headers) : [headers.get("set-cookie") ?? ""];
}

function parseSetCookies(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    for (const chunk of header.split(/,(?=\s*__Host-agvsr_)/)) {
      const pair = chunk.split(";")[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

async function login(webEndpoint: string, startupToken: string): Promise<LoginResult> {
  const origin = browserOrigin(webEndpoint);
  const res = await gatewayFetch(webEndpoint, "/api/session/login", {
    method: "POST",
    headers: {
      origin,
      "x-csrf-token": startupToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ token: startupToken }),
  });
  const body = (await res.json()) as { csrfToken: string };
  const cookies = parseSetCookies(responseSetCookies(res.headers));
  const sessionCookie = cookies["__Host-agvsr_session"] ?? "";
  const csrfCookie = cookies["__Host-agvsr_csrf"] ?? body.csrfToken;
  const cookieHeader = `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`;
  return { cookieHeader, csrfToken: csrfCookie, sessionCookie, csrfCookie };
}

// Minimal team with no roles needed for push tests
const MIN_TEAM = `
roles:
  supervisor: { adapter: claude-code, model: fake }
`;

// ---------------------------------------------------------------------------
// 1. Store migration and table behavior
// ---------------------------------------------------------------------------
describe("WebAuthStore VAPID and subscription tables", () => {
  it("creates VAPID keys lazily and returns same keys on re-read", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const keys1 = await store.getOrCreateVapidKeys();
      expect(keys1.publicKey).toBeTruthy();
      expect(keys1.privateKey).toBeTruthy();
      // Second call returns same keys
      const keys2 = await store.getOrCreateVapidKeys();
      expect(keys2.publicKey).toBe(keys1.publicKey);
      expect(keys2.privateKey).toBe(keys1.privateKey);
      store.close();

      // Reopening the store file returns the same keys
      const store2 = new WebAuthStore(db);
      const keys3 = await store2.getOrCreateVapidKeys();
      expect(keys3.publicKey).toBe(keys1.publicKey);
      store2.close();
    } finally {
      cleanup(dir);
    }
  });

  it("getVapidPublicKey returns null before initialization and key after", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      expect(store.getVapidPublicKey()).toBeNull();
      const keys = await store.getOrCreateVapidKeys();
      expect(store.getVapidPublicKey()).toBe(keys.publicKey);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("private key never equals public key", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const keys = await store.getOrCreateVapidKeys();
      expect(keys.publicKey).not.toBe(keys.privateKey);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("addPushSubscription upserts and listPushSubscriptions returns it", () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      store.addPushSubscription({
        endpoint: "https://push.example.com/sub/abc",
        p256dh: "fakep256dh",
        auth: "fakeauth",
      });
      const subs = store.listPushSubscriptions();
      expect(subs.length).toBe(1);
      expect(subs[0]!.endpoint).toBe("https://push.example.com/sub/abc");
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("removePushSubscription deletes the row", () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      store.addPushSubscription({
        endpoint: "https://push.example.com/sub/xyz",
        p256dh: "p256",
        auth: "auth",
      });
      store.removePushSubscription("https://push.example.com/sub/xyz");
      expect(store.listPushSubscriptions().length).toBe(0);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("upserts on duplicate endpoint (updates p256dh and auth)", () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      store.addPushSubscription({
        endpoint: "https://push.example.com/sub/dup",
        p256dh: "old",
        auth: "old",
      });
      store.addPushSubscription({
        endpoint: "https://push.example.com/sub/dup",
        p256dh: "new",
        auth: "new",
      });
      const subs = store.listPushSubscriptions();
      expect(subs.length).toBe(1);
      expect(subs[0]!.p256dh).toBe("new");
      store.close();
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Push API security and validation (requires live gateway)
// ---------------------------------------------------------------------------
describe("push API endpoints security and validation", () => {
  it("GET /sw.js returns JS with Service-Worker-Allowed header", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const res = await gatewayFetch(web.endpoint, "/sw.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("javascript");
      expect(res.headers.get("Service-Worker-Allowed")).toBe("/");
    } finally {
      cleanup(dir);
    }
  });

  it("GET /api/push/config requires session and returns vapidPublicKey only", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);

      // Without auth → 401
      const unauth = await gatewayFetch(web.endpoint, "/api/push/config");
      expect(unauth.status).toBe(401);

      // With auth
      const { cookieHeader } = await login(web.endpoint, web.startupToken);
      const res = await gatewayFetch(web.endpoint, "/api/push/config", {
        headers: { cookie: cookieHeader, origin },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vapidPublicKey: string; enabled: boolean };
      expect(body.enabled).toBe(true);
      expect(typeof body.vapidPublicKey).toBe("string");
      expect(body.vapidPublicKey.length).toBeGreaterThan(0);
      expect((body as unknown as Record<string, unknown>).privateKey).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe: no session → 401", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ endpoint: "https://push.example.com/1", keys: { p256dh: "x", auth: "y" } }),
      });
      expect(res.status).toBe(401);
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe: bad origin → 403", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin: "http://evil.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint: "https://push.example.com/1", keys: { p256dh: "x", auth: "y" } }),
      });
      expect(res.status).toBe(403);
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe: CSRF mismatch → 403", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader } = await login(web.endpoint, web.startupToken);
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": "wrong-token",
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint: "https://push.example.com/1", keys: { p256dh: "x", auth: "y" } }),
      });
      expect(res.status).toBe(403);
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe: non-https endpoint → 400", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint: "http://push.example.com/1", keys: { p256dh: "x", auth: "y" } }),
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe: invalid JSON → 400", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/subscribe success → 201 and row in store", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const endpoint = "https://push.example.com/sub/test-sub-123";
      const res = await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          endpoint,
          keys: { p256dh: "dGVzdHB1Ymxp", auth: "dGVzdGF1dGg" },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { subscribed: boolean };
      expect(body.subscribed).toBe(true);

      // Verify row in store
      const store = new WebAuthStore(db);
      const subs = store.listPushSubscriptions();
      expect(subs.some((s) => s.endpoint === endpoint)).toBe(true);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("POST /api/push/unsubscribe success → 200 and row removed", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const endpoint = "https://push.example.com/sub/to-remove";

      // Subscribe first
      await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint, keys: { p256dh: "dGVzdA", auth: "dGVzdA" } }),
      });

      // Unsubscribe
      const res = await gatewayFetch(web.endpoint, "/api/push/unsubscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { unsubscribed: boolean };
      expect(body.unsubscribed).toBe(true);

      const store = new WebAuthStore(db);
      expect(store.listPushSubscriptions().length).toBe(0);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("push subscribe/unsubscribe does NOT write to web_operation_audit", async () => {
    const dir = makeTmpDir();
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    mkdirSync(join(dir, "repo"), { recursive: true });
    try {
      daemonInst = await startDaemon({
        endpoint: sock,
        storeFile: db,
        team: parseTeam(MIN_TEAM),
        interruptRunningJobsOnStart: false,
        turnRunner: async (d) => ({
          events: [],
          outcome: { sessionId: `${d.role}-s`, finalText: "", exitCode: 0 },
        }),
      });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });
      const origin = browserOrigin(web.endpoint);
      const { cookieHeader, csrfToken } = await login(web.endpoint, web.startupToken);
      const endpoint = "https://push.example.com/sub/no-audit";

      await gatewayFetch(web.endpoint, "/api/push/subscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint, keys: { p256dh: "dGVzdA", auth: "dGVzdA" } }),
      });
      await gatewayFetch(web.endpoint, "/api/push/unsubscribe", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({ endpoint }),
      });

      const store = new WebAuthStore(db);
      const audits = store.listWebOperationAudit();
      expect(audits.some((a) => a.operation.startsWith("push"))).toBe(false);
      store.close();
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Real crypto smoke test (no mocked crypto paths)
// ---------------------------------------------------------------------------
describe("real crypto smoke test", () => {
  it("VAPID keys are real P-256 EC points (65-byte uncompressed raw)", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const keys = await store.getOrCreateVapidKeys();
      const pubRaw = Buffer.from(keys.publicKey, "base64url");
      // Uncompressed P-256 point: 0x04 + 32-byte x + 32-byte y = 65 bytes
      expect(pubRaw.length).toBe(65);
      expect(pubRaw[0]).toBe(0x04);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("encrypt/decrypt round-trip without mocked crypto", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const vapidKeys = await store.getOrCreateVapidKeys();

      // Generate a fake browser subscriber key pair (P-256 ECDH)
      const subscriberKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const subscriberPublicRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", subscriberKeyPair.publicKey),
      );
      const authSecret = crypto.getRandomValues(new Uint8Array(16));

      const p256dh = Buffer.from(subscriberPublicRaw).toString("base64url");
      const authB64 = Buffer.from(authSecret).toString("base64url");

      // Register fake subscription
      const fakeEndpoint = "https://push.test.invalid/sub/smoke";
      const subscription: PushSubscriptionRow = {
        endpoint: fakeEndpoint,
        p256dh,
        auth: authB64,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      };

      const payload: PushPayload = { job_id: randomUUID(), status: "done" };
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));

      // Start a local fake push endpoint
      let receivedBody: Uint8Array | null = null;
      let receivedContentEncoding: string | null = null;
      let receivedAuthorization: string | null = null;
      let fakeServerPublicRaw: Buffer | null = null;
      let fakeSalt: Buffer | null = null;

      const fakeServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          receivedContentEncoding = req.headers.get("Content-Encoding");
          receivedAuthorization = req.headers.get("Authorization");
          const buf = await req.arrayBuffer();
          const raw = Buffer.from(buf);
          receivedBody = raw;

          // Parse the binary header: salt(16) + rs(4) + idlen(1) + keyid(65)
          fakeSalt = raw.subarray(0, 16) as Buffer;
          // rs is bytes 16-19 (big-endian uint32)
          fakeServerPublicRaw = raw.subarray(21, 86) as Buffer; // 21 = 16+4+1, len=65

          return new Response(null, { status: 201 });
        },
      });

      // Override endpoint to our fake server
      const realEndpoint = `http://127.0.0.1:${fakeServer.port}/push/smoke`;
      const testSubscription: PushSubscriptionRow = {
        ...subscription,
        endpoint: realEndpoint,
      };

      const result = await sendPush(testSubscription, vapidKeys, payloadBytes);
      fakeServer.stop();

      expect(result.pruneEndpoint).toBe(false);
      expect(receivedContentEncoding ?? "").toBe("aes128gcm");
      expect(receivedAuthorization ?? "").toContain("vapid t=");
      expect(receivedAuthorization ?? "").toContain(", k=");
      expect(receivedBody).not.toBeNull();

      // Decrypt using subscriber private key
      const uaPublicRaw = Buffer.from(p256dh, "base64url");

      function toABTest(buf: Buffer): ArrayBuffer {
        return (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }

      // Derive ECDH shared secret between subscriber private key and server ephemeral public key
      const serverEphemeralPub = await crypto.subtle.importKey(
        "raw",
        toABTest(fakeServerPublicRaw!),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
      const ecdhSecretBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: serverEphemeralPub },
        subscriberKeyPair.privateKey,
        256,
      );
      const ecdhSecret = new Uint8Array(ecdhSecretBits);

      // Derive CEK + nonce using the helper exported from push.ts
      const { cek, nonce } = await deriveEncryptionKeys(
        ecdhSecret,
        authSecret,
        uaPublicRaw,
        fakeServerPublicRaw!,
        fakeSalt!,
      );

      // Decrypt the ciphertext (everything after the 86-byte header)
      const ciphertext = receivedBody!.slice(86);
      const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
        "decrypt",
      ]);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext);

      // Remove the 0x02 delimiter byte at the end
      const decryptedBytes = new Uint8Array(decrypted);
      expect(decryptedBytes[decryptedBytes.length - 1]).toBe(0x02);
      const plaintext = new TextDecoder().decode(decryptedBytes.slice(0, -1));
      const decoded = JSON.parse(plaintext) as PushPayload;
      expect(decoded.job_id).toBe(payload.job_id);
      expect(decoded.status).toBe(payload.status);

      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("sendPush returns pruneEndpoint=true on 404", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const vapidKeys = await store.getOrCreateVapidKeys();

      const subscriberKP = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const subPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", subscriberKP.publicKey));
      const fakeAuth = crypto.getRandomValues(new Uint8Array(16));

      const fakeServer404 = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(null, { status: 404 });
        },
      });

      const sub: PushSubscriptionRow = {
        endpoint: `http://127.0.0.1:${fakeServer404.port}/dead`,
        p256dh: Buffer.from(subPubRaw).toString("base64url"),
        auth: Buffer.from(fakeAuth).toString("base64url"),
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      };
      const result = await sendPush(sub, vapidKeys, new TextEncoder().encode("test"));
      fakeServer404.stop();
      expect(result.pruneEndpoint).toBe(true);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("sendPush returns pruneEndpoint=true on 410", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const store = new WebAuthStore(db);
      const vapidKeys = await store.getOrCreateVapidKeys();

      const subscriberKP = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const subPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", subscriberKP.publicKey));
      const fakeAuth = crypto.getRandomValues(new Uint8Array(16));

      const fakeServer410 = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(null, { status: 410 });
        },
      });

      const sub: PushSubscriptionRow = {
        endpoint: `http://127.0.0.1:${fakeServer410.port}/gone`,
        p256dh: Buffer.from(subPubRaw).toString("base64url"),
        auth: Buffer.from(fakeAuth).toString("base64url"),
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      };
      const result = await sendPush(sub, vapidKeys, new TextEncoder().encode("test"));
      fakeServer410.stop();
      expect(result.pruneEndpoint).toBe(true);
      store.close();
    } finally {
      cleanup(dir);
    }
  });

  it("createPushNotifier prunes 404/410 subscriptions from store", async () => {
    const dir = makeTmpDir();
    const db = join(dir, "store.sqlite");
    try {
      const { createPushNotifier } = await import("../src/web/push.ts");

      const store = new WebAuthStore(db);
      await store.getOrCreateVapidKeys();

      const subscriberKP = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const subPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", subscriberKP.publicKey));
      const fakeAuth = crypto.getRandomValues(new Uint8Array(16));

      const deadServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(null, { status: 410 });
        },
      });

      const deadEndpoint = `http://127.0.0.1:${deadServer.port}/gone`;
      store.addPushSubscription({
        endpoint: deadEndpoint,
        p256dh: Buffer.from(subPubRaw).toString("base64url"),
        auth: Buffer.from(fakeAuth).toString("base64url"),
      });
      store.close();

      const notifier = createPushNotifier(db);
      notifier({ job_id: randomUUID(), status: "done" });

      // Wait for fire-and-forget to complete
      await Bun.sleep(500);
      deadServer.stop();

      const store2 = new WebAuthStore(db);
      expect(store2.listPushSubscriptions().length).toBe(0);
      store2.close();
    } finally {
      cleanup(dir);
    }
  });
});
