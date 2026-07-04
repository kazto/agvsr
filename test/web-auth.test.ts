import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon/daemon.ts";
import { startWebGateway } from "../src/web/server.ts";
import type { Daemon } from "../src/daemon/daemon.ts";

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

describe("web auth", () => {
  it("hashes the startup token, sets secure cookies, and enforces CSRF on logout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agvsr-web-auth-"));
    const sock = join(dir, "agvsrd.sock");
    const db = join(dir, "store.sqlite");
    const oldStore = process.env.AGVSR_STORE;
    const oldSock = process.env.AGVSR_SOCK;
    process.env.AGVSR_STORE = db;
    process.env.AGVSR_SOCK = sock;

    try {
      daemon = await startDaemon({ endpoint: sock, storeFile: db, team: null });
      web = await startWebGateway({ daemonEndpoint: sock, storeFile: db });

      const storeBytes = readFileSync(db);
      expect(storeBytes.includes(Buffer.from(web.startupToken))).toBe(false);

      const sqlite = new Database(db);
      const tables = sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'web_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "web_bootstrap_tokens",
        "web_operation_audit",
        "web_sessions",
      ]);
      sqlite.close();

      const origin = browserOrigin(web.endpoint);

      const badLogin = await gatewayFetch(web.endpoint, "/api/session/login", {
        method: "POST",
        headers: {
          origin,
          "x-csrf-token": "wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: web.startupToken }),
      });
      expect(badLogin.status).toBe(403);

      const badOrigin = await gatewayFetch(web.endpoint, "/api/session/login", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost:9999",
          "x-csrf-token": web.startupToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: web.startupToken }),
      });
      expect(badOrigin.status).toBe(403);

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

      const setCookies = responseSetCookies(login.headers);
      const setCookie = setCookies.join("\n");
      expect(setCookie).toContain("__Host-agvsr_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("__Host-agvsr_csrf=");

      const loginBody = (await login.json()) as { csrfToken: string };
      expect(loginBody.csrfToken).not.toBe("");

      const sessionCookie = setCookie.match(/__Host-agvsr_session=([^;,\s]+)/)?.[1];
      const csrfCookie =
        setCookie.match(/__Host-agvsr_csrf=([^;,\s]+)/)?.[1] ?? loginBody.csrfToken;
      expect(sessionCookie).toBeTruthy();

      const session = await gatewayFetch(web.endpoint, "/api/session", {
        headers: {
          cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`,
        },
      });
      const sessionBody = (await session.json()) as {
        authenticated: boolean;
        csrfToken?: string;
      };
      expect(sessionBody.authenticated).toBe(true);
      expect(sessionBody.csrfToken).toBe(csrfCookie);

      const logout = await gatewayFetch(web.endpoint, "/api/session/logout", {
        method: "POST",
        headers: {
          origin,
          cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`,
          "x-csrf-token": csrfCookie,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(logout.status).toBe(200);

      const afterLogout = await gatewayFetch(web.endpoint, "/api/session", {
        headers: {
          cookie: `__Host-agvsr_session=${sessionCookie}; __Host-agvsr_csrf=${csrfCookie}`,
        },
      });
      const afterLogoutBody = (await afterLogout.json()) as { authenticated: boolean };
      expect(afterLogoutBody.authenticated).toBe(false);
    } finally {
      process.env.AGVSR_STORE = oldStore;
      process.env.AGVSR_SOCK = oldSock;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
