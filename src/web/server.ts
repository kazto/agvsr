import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ipcEndpoint, storePath, webSocketPath } from "../paths.ts";
import { hashToken, parseCookieHeader, randomToken, SESSION_COOKIE } from "./auth.ts";
import { WebAuthStore } from "./auth-store.ts";
import { WebDaemonClient } from "./ipc.ts";
import { handleWebRequest, type WebRouteContext } from "./routes.ts";
import { allowedHost, loopbackHosts } from "./security.ts";
import { createWebStreamBridge } from "./stream.ts";

export interface WebGatewayOptions {
  daemonEndpoint?: string;
  storeFile?: string;
  host?: string;
  port?: number;
  socket?: string;
}

export interface WebGateway {
  endpoint: string;
  startupToken: string;
  close(): Promise<void>;
}

interface ServeResult {
  url: URL;
  stop(): void;
}

function defaultHost(): string {
  return "127.0.0.1";
}

function parsePort(raw?: string | number): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`invalid port: ${raw}`);
  }
  return n;
}

function loopbackOrigins(port?: number): Set<string> {
  if (port === undefined) {
    return new Set(["http://localhost", "http://127.0.0.1", "http://[::1]"]);
  }
  const p = String(port);
  return new Set([`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`]);
}

function originsForUrl(url: URL): Set<string> {
  if (url.protocol === "unix:") return loopbackOrigins();
  return loopbackOrigins(Number(url.port));
}

async function loadClientSource(path: string): Promise<string> {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  return transpiler.transformSync(await Bun.file(path).text());
}

export async function startWebGateway(options: WebGatewayOptions = {}): Promise<WebGateway> {
  const daemonEndpoint = options.daemonEndpoint ?? ipcEndpoint();
  const storeFile = options.storeFile ?? storePath();
  const authStore = new WebAuthStore(storeFile);
  const daemon = await WebDaemonClient.connect(daemonEndpoint);
  let stream: Awaited<ReturnType<typeof createWebStreamBridge>> | null = null;
  let startupToken = "";
  let endpoint = "";
  let server: ServeResult | null = null;
  let ctx: WebRouteContext | null = null;

  try {
    stream = await createWebStreamBridge(daemonEndpoint);
    startupToken = randomToken();
    const startupTokenHash = hashToken(startupToken);
    authStore.setBootstrapToken(startupTokenHash);

    const clientPath = fileURLToPath(new URL("./client/app.ts", import.meta.url));
    const cssPath = fileURLToPath(new URL("./client/styles.css", import.meta.url));
    const swPath = fileURLToPath(new URL("./client/sw.ts", import.meta.url));
    const clientSource = await loadClientSource(clientPath);
    const cssSource = await Bun.file(cssPath).text();
    const swSource = await loadClientSource(swPath);

    await authStore.getOrCreateVapidKeys();

    ctx = {
      authStore,
      daemon,
      startupToken,
      startupTokenHash,
      hostAllowlist: loopbackHosts(),
      originAllowlist: new Set(),
      assets: {
        appJs: clientSource,
        appCss: cssSource,
        swJs: swSource,
      },
    };

    const wantsSocket =
      options.socket ?? (process.platform === "win32" ? undefined : webSocketPath());
    const host = options.host ?? defaultHost();
    const port = parsePort(options.port);

    const fetch = async (request: Request, server: Bun.Server<{ jobId: string }>) => {
      const webCtx = ctx!;
      const url = new URL(request.url);
      const pathname = url.pathname;
      const isStreamUpgrade =
        request.method === "GET" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        pathname.startsWith("/api/jobs/") &&
        pathname.endsWith("/stream");
      if (!isStreamUpgrade) {
        return handleWebRequest(webCtx, request);
      }

      const hostHeader = request.headers.get("host");
      if (!hostHeader || !allowedHost(hostHeader, webCtx.hostAllowlist)) {
        return new Response(JSON.stringify({ error: "host not allowed" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      const origin = request.headers.get("origin");
      if (!origin || !webCtx.originAllowlist.has(new URL(origin).origin)) {
        return new Response(JSON.stringify({ error: "origin not allowed" }), {
          status: 403,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      const cookies = parseCookieHeader(request.headers.get("cookie"));
      const sessionToken = cookies.get(SESSION_COOKIE);
      const sessionHash = sessionToken ? hashToken(sessionToken) : null;
      if (!sessionHash || !webCtx.authStore.getSession(sessionHash)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      const prefix = "/api/jobs/";
      const suffix = "/stream";
      let jobId = "";
      try {
        jobId = decodeURIComponent(pathname.slice(prefix.length, pathname.length - suffix.length));
      } catch {
        return new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      if (!jobId) {
        return new Response(JSON.stringify({ error: "bad request" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      const upgraded = server.upgrade(request, { data: { jobId } });
      if (!upgraded) {
        return new Response(JSON.stringify({ error: "websocket upgrade failed" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    };

    const useUnix =
      wantsSocket &&
      process.platform !== "win32" &&
      options.host === undefined &&
      options.port === undefined;
    if (useUnix) {
      try {
        server = Bun.serve({
          unix: wantsSocket,
          fetch,
          websocket: stream.websocket,
        });
        if (existsSync(wantsSocket)) chmodSync(wantsSocket, 0o600);
        endpoint = server.url.toString();
      } catch (err) {
        if (options.socket !== undefined) throw err;
        server = null;
      }
    }
    if (!server) {
      server = Bun.serve({
        hostname: host,
        port: port ?? 0,
        fetch,
        websocket: stream.websocket,
      });
      endpoint = server.url.toString();
    }
    ctx.originAllowlist = originsForUrl(server.url);
  } catch (err) {
    await daemon.close();
    await stream?.close();
    authStore.close();
    throw err;
  }

  return {
    endpoint,
    startupToken,
    async close() {
      server?.stop();
      await stream?.close();
      await daemon.close();
      authStore.close();
    },
  };
}
