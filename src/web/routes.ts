import {
  allowedHost,
  allowedOrigin,
  getSecurityHeaders,
  isStateChangingMethod,
} from "./security.ts";
import {
  clearCookie,
  hashToken,
  parseCookieHeader,
  randomToken,
  serializeCookie,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "./auth.ts";
import type { WebAuthStore } from "./auth-store.ts";
import type { WebDaemonClient, JobDetailView, JobView } from "./ipc.ts";

const STALL_THRESHOLD_MS = 10 * 60 * 1000;
type HeaderInit = ConstructorParameters<typeof Headers>[0];

export interface WebRouteContext {
  authStore: WebAuthStore;
  daemon: WebDaemonClient;
  startupToken: string;
  startupTokenHash: string;
  hostAllowlist: Set<string>;
  originAllowlist: Set<string>;
  assets: {
    appJs: string;
    appCss: string;
  };
}

function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(getSecurityHeaders());
  if (init?.headers) {
    for (const [key, value] of new Headers(init.headers)) {
      headers.set(key, value);
    }
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function deriveJobDisplayState(
  job: JobDetailView["job"],
  runtime: JobDetailView["runtime"],
): JobView["display_state"] {
  return job.status !== "running"
    ? "terminal"
    : runtime.in_flight
      ? "in_flight"
      : runtime.idle_ms !== null && runtime.idle_ms >= STALL_THRESHOLD_MS
        ? "possibly_stalled"
        : "idle";
}

function viewForJob(job: JobDetailView["job"], runtime: JobDetailView["runtime"]): JobView {
  const display_state = deriveJobDisplayState(job, runtime);
  return { job, runtime, display_state };
}

async function jobsWithRuntime(ctx: WebRouteContext): Promise<JobView[]> {
  const jobs = await ctx.daemon.listJobs();
  const views = await Promise.all(
    jobs.map(async (job) => {
      const { runtime } = await ctx.daemon.getJob(job.id);
      return viewForJob(job, runtime);
    }),
  );
  return views;
}

async function detailForJob(ctx: WebRouteContext, id: string): Promise<JobDetailView | null> {
  const result = await ctx.daemon.getJob(id);
  const messages = await ctx.daemon.listMessages(id);
  return {
    ...viewForJob(result.job, result.runtime),
    messages,
  };
}

function sessionView(ctx: WebRouteContext, cookies: Map<string, string>): Response {
  const sessionToken = cookies.get(SESSION_COOKIE);
  if (!sessionToken) {
    return json({ authenticated: false });
  }
  const sessionHash = hashToken(sessionToken);
  const session = ctx.authStore.getSession(sessionHash);
  if (!session) {
    return json({ authenticated: false });
  }
  ctx.authStore.touchSession(sessionHash);
  const fresh = ctx.authStore.getSession(sessionHash) ?? session;
  const csrfToken = cookies.get(CSRF_COOKIE);
  return json({
    authenticated: true,
    session: {
      created_at: fresh.created_at,
      last_seen_at: fresh.last_seen_at,
    },
    csrfToken: csrfToken ?? "",
  });
}

function makeHeaders(extra?: HeaderInit): Headers {
  const headers = new Headers(getSecurityHeaders());
  headers.set("Cache-Control", "no-store");
  if (extra) {
    for (const [key, value] of new Headers(extra)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function textResponse(body: string, contentType: string, extra?: HeaderInit): Response {
  const headers = makeHeaders();
  headers.set("Content-Type", contentType);
  if (extra) {
    for (const [key, value] of new Headers(extra)) {
      headers.set(key, value);
    }
  }
  return new Response(body, { headers });
}

function htmlShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>agvsr web</title>
    <link rel="stylesheet" href="/assets/app.css">
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;
}

function loginResponse(
  ctx: WebRouteContext,
  body: { token?: string },
  csrfToken: string | null,
): Response {
  const token = body.token?.trim() ?? "";
  if (!token) return json({ error: "token required" }, { status: 400 });
  if (!csrfToken || csrfToken !== token) {
    return json({ error: "csrf token mismatch" }, { status: 403 });
  }
  const tokenHash = hashToken(token);
  if (!ctx.authStore.hasBootstrapToken(tokenHash)) {
    return json({ error: "invalid startup token" }, { status: 401 });
  }
  if (!ctx.authStore.consumeBootstrapToken(tokenHash)) {
    return json({ error: "startup token already used" }, { status: 401 });
  }

  const sessionToken = randomToken();
  const sessionHash = hashToken(sessionToken);
  ctx.authStore.createSession(sessionHash);
  const sessionCsrf = randomToken();
  const headers = makeHeaders();
  headers.append(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    }),
  );
  headers.append(
    "Set-Cookie",
    serializeCookie(CSRF_COOKIE, sessionCsrf, {
      secure: true,
      sameSite: "Strict",
      path: "/",
    }),
  );
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ authenticated: true, csrfToken: sessionCsrf }), {
    status: 200,
    headers,
  });
}

function logoutResponse(
  ctx: WebRouteContext,
  cookies: Map<string, string>,
  csrfHeader: string | null,
): Response {
  const sessionToken = cookies.get(SESSION_COOKIE);
  const csrfCookie = cookies.get(CSRF_COOKIE);
  if (!sessionToken || !csrfCookie) {
    return json({ error: "not authenticated" }, { status: 401 });
  }
  if (csrfHeader !== csrfCookie) {
    return json({ error: "csrf token mismatch" }, { status: 403 });
  }
  const sessionHash = hashToken(sessionToken);
  ctx.authStore.deleteSession(sessionHash);
  const headers = makeHeaders();
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  headers.append("Set-Cookie", clearCookie(CSRF_COOKIE));
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ authenticated: false }), {
    status: 200,
    headers,
  });
}

export async function handleWebRequest(ctx: WebRouteContext, request: Request): Promise<Response> {
  const host = request.headers.get("host");
  if (!host || !allowedHost(host, ctx.hostAllowlist)) {
    return json({ error: "host not allowed" }, { status: 403, headers: getSecurityHeaders() });
  }
  const origin = request.headers.get("origin");
  const unsafe = isStateChangingMethod(request.method);
  if ((unsafe && !origin) || (origin && !allowedOrigin(origin, ctx.originAllowlist))) {
    return json({ error: "origin not allowed" }, { status: 403, headers: getSecurityHeaders() });
  }
  const cookies = parseCookieHeader(request.headers.get("cookie"));

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/") {
    return textResponse(htmlShell(), "text/html; charset=utf-8");
  }
  if (pathname === "/assets/app.js") {
    return textResponse(ctx.assets.appJs, "application/javascript; charset=utf-8");
  }
  if (pathname === "/assets/app.css") {
    return textResponse(ctx.assets.appCss, "text/css; charset=utf-8");
  }

  if (pathname === "/api/session" && request.method === "GET") {
    return sessionView(ctx, cookies);
  }

  if (pathname === "/api/session/login" && request.method === "POST") {
    const csrf = request.headers.get("x-csrf-token");
    const body = (await request.json().catch(() => ({}))) as { token?: string };
    return loginResponse(ctx, body, csrf);
  }

  if (pathname === "/api/session/logout" && request.method === "POST") {
    const csrf = request.headers.get("x-csrf-token");
    return logoutResponse(ctx, cookies, csrf);
  }

  if (pathname === "/api/jobs" && request.method === "GET") {
    const sessionToken = cookies.get(SESSION_COOKIE);
    const sessionHash = sessionToken ? hashToken(sessionToken) : null;
    if (!sessionHash || !ctx.authStore.getSession(sessionHash)) {
      return json({ error: "unauthorized" }, { status: 401, headers: getSecurityHeaders() });
    }
    const jobs = await jobsWithRuntime(ctx);
    return json({ jobs });
  }

  if (pathname.startsWith("/api/jobs/") && request.method === "GET") {
    const sessionToken = cookies.get(SESSION_COOKIE);
    const sessionHash = sessionToken ? hashToken(sessionToken) : null;
    if (!sessionHash || !ctx.authStore.getSession(sessionHash)) {
      return json({ error: "unauthorized" }, { status: 401, headers: getSecurityHeaders() });
    }
    const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
    const detail = await detailForJob(ctx, id);
    if (!detail) return json({ error: "not found" }, { status: 404 });
    return json(detail);
  }

  if (pathname.startsWith("/api/")) {
    return json({ error: "not found" }, { status: 404, headers: getSecurityHeaders() });
  }

  if (unsafe) {
    return json({ error: "method not allowed" }, { status: 405, headers: getSecurityHeaders() });
  }

  return json({ error: "not found" }, { status: 404, headers: getSecurityHeaders() });
}
