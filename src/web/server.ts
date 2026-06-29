import { chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ipcEndpoint, storePath, webSocketPath } from "../paths.ts";
import { randomToken, hashToken } from "./auth.ts";
import { WebAuthStore } from "./auth-store.ts";
import { WebDaemonClient } from "./ipc.ts";
import { handleWebRequest, type WebRouteContext } from "./routes.ts";
import { loopbackHosts } from "./security.ts";

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
  const startupToken = randomToken();
  const startupTokenHash = hashToken(startupToken);
  authStore.setBootstrapToken(startupTokenHash);

  const clientPath = fileURLToPath(new URL("./client/app.ts", import.meta.url));
  const cssPath = fileURLToPath(new URL("./client/styles.css", import.meta.url));
  const clientSource = await loadClientSource(clientPath);
  const cssSource = await Bun.file(cssPath).text();

  const ctx: WebRouteContext = {
    authStore,
    daemon,
    startupToken,
    startupTokenHash,
    hostAllowlist: loopbackHosts(),
    originAllowlist: new Set(),
    assets: {
      appJs: clientSource,
      appCss: cssSource,
    },
  };

  const wantsSocket =
    options.socket ?? (process.platform === "win32" ? undefined : webSocketPath());
  const host = options.host ?? defaultHost();
  const port = parsePort(options.port);

  let server: ServeResult | null = null;
  let endpoint = "";

  const fetch = (request: Request) => handleWebRequest(ctx, request);

  try {
    const useUnix =
      wantsSocket &&
      process.platform !== "win32" &&
      options.host === undefined &&
      options.port === undefined;
    if (useUnix) {
      try {
        server = Bun.serve({ unix: wantsSocket, fetch });
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
      });
      endpoint = server.url.toString();
    }
    ctx.originAllowlist = originsForUrl(server.url);
  } catch (err) {
    await daemon.close();
    authStore.close();
    throw err;
  }

  return {
    endpoint,
    startupToken,
    async close() {
      server?.stop();
      await daemon.close();
      authStore.close();
    },
  };
}
