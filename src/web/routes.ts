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
import { WebDaemonError, type WebDaemonClient, type JobDetailView, type JobView } from "./ipc.ts";

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
    swJs: string;
  };
}

export function hasAuthenticatedSession(
  ctx: Pick<WebRouteContext, "authStore">,
  cookies: Map<string, string>,
): boolean {
  const sessionToken = cookies.get(SESSION_COOKIE);
  if (!sessionToken) return false;
  const sessionHash = hashToken(sessionToken);
  return ctx.authStore.getSession(sessionHash) !== null;
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

function errorJson(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, { status });
}

function textPreview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function summarizeCreateRequest(goal: string, cwd: string, id: string | null): string {
  return JSON.stringify({
    goal_preview: textPreview(goal, 160),
    goal_length: goal.length,
    cwd,
    custom_id: id,
  });
}

function summarizeTellRequest(body: string): string {
  return JSON.stringify({
    body_preview: textPreview(body, 160),
    body_length: body.length,
  });
}

function summarizeEmptyRequest(): string {
  return "{}";
}

function daemonStatusForCode(code: string): number {
  switch (code) {
    case "bad_request":
    case "provisioning_failed":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "no_team":
      return 503;
    default:
      return 500;
  }
}

function daemonErrorResponse(err: unknown): Response {
  if (err instanceof WebDaemonError) {
    return errorJson(err.code, err.message, daemonStatusForCode(err.code));
  }
  return errorJson("internal", err instanceof Error ? err.message : "unexpected error", 500);
}

function authenticatedSessionHash(
  ctx: WebRouteContext,
  cookies: Map<string, string>,
): string | null {
  const sessionToken = cookies.get(SESSION_COOKIE);
  if (!sessionToken) return null;
  const sessionHash = hashToken(sessionToken);
  if (!ctx.authStore.getSession(sessionHash)) return null;
  return sessionHash;
}

function csrfMatches(cookies: Map<string, string>, csrfHeader: string | null): boolean {
  const csrfCookie = cookies.get(CSRF_COOKIE);
  return Boolean(csrfCookie && csrfHeader && csrfCookie === csrfHeader);
}

function readJobIdFromPath(pathname: string, suffix: string): string | null {
  try {
    const raw = pathname.slice("/api/jobs/".length, pathname.length - suffix.length);
    const decoded = decodeURIComponent(raw);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
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
  if (!hasAuthenticatedSession(ctx, cookies)) {
    return json({ authenticated: false });
  }
  const sessionToken = cookies.get(SESSION_COOKIE)!;
  const sessionHash = hashToken(sessionToken);
  const session = ctx.authStore.getSession(sessionHash)!;
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

function recordAttempt(
  ctx: WebRouteContext,
  sessionHash: string,
  operation: string,
  jobId: string | null,
  requestSummary: string,
): number | null {
  try {
    return ctx.authStore.createWebOperationAudit({
      session_hash: sessionHash,
      operation,
      job_id: jobId,
      status: "attempted",
      error_code: null,
      request_summary: requestSummary,
    }).id;
  } catch {
    return null;
  }
}

function finalizeAttempt(
  ctx: WebRouteContext,
  auditId: number | null,
  status: "success" | "failure",
  errorCode: string | null = null,
  jobId: string | null | undefined = undefined,
): void {
  if (auditId === null) return;
  try {
    ctx.authStore.updateWebOperationAudit({
      id: auditId,
      status,
      error_code: errorCode,
      ...(jobId !== undefined ? { job_id: jobId } : {}),
    });
  } catch {
    /* fail open after the attempt has been recorded */
  }
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
  if (pathname === "/sw.js") {
    const headers = makeHeaders({
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-store",
    });
    headers.set("Content-Type", "application/javascript; charset=utf-8");
    return new Response(ctx.assets.swJs, { headers });
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

  if (pathname === "/api/jobs" && request.method === "POST") {
    const sessionHash = authenticatedSessionHash(ctx, cookies);
    if (!sessionHash) {
      return errorJson("unauthorized", "unauthorized", 401);
    }
    ctx.authStore.touchSession(sessionHash);

    const csrfHeader = request.headers.get("x-csrf-token");
    const raw = (await request.json().catch(() => ({}))) as {
      goal?: unknown;
      cwd?: unknown;
      id?: unknown;
    };
    const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
    const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
    const customId = typeof raw.id === "string" ? raw.id.trim() : "";
    const requestSummary = summarizeCreateRequest(goal, cwd, customId || null);
    const auditId = recordAttempt(ctx, sessionHash, "job.create", null, requestSummary);
    if (auditId === null) {
      return errorJson("internal", "audit write failed", 500);
    }

    if (!csrfMatches(cookies, csrfHeader)) {
      finalizeAttempt(ctx, auditId, "failure", "csrf_mismatch");
      return errorJson("csrf_mismatch", "csrf token mismatch", 403);
    }
    if (!goal) {
      finalizeAttempt(ctx, auditId, "failure", "bad_request");
      return errorJson("bad_request", "goal must not be empty", 400);
    }
    if (Buffer.byteLength(goal, "utf8") > 8 * 1024) {
      finalizeAttempt(ctx, auditId, "failure", "bad_request");
      return errorJson("bad_request", "goal must not exceed 8 KiB", 400);
    }
    if (!cwd) {
      finalizeAttempt(ctx, auditId, "failure", "bad_request");
      return errorJson("bad_request", "cwd must not be empty", 400);
    }
    if (Buffer.byteLength(cwd, "utf8") > 4 * 1024) {
      finalizeAttempt(ctx, auditId, "failure", "bad_request");
      return errorJson("bad_request", "cwd must not exceed 4 KiB", 400);
    }
    if (customId && Buffer.byteLength(customId, "utf8") > 128) {
      finalizeAttempt(ctx, auditId, "failure", "bad_request");
      return errorJson("bad_request", "job id must not exceed 128 bytes", 400);
    }

    try {
      const created = await ctx.daemon.createJob(goal, cwd, customId || undefined);
      const detail = await ctx.daemon.getJob(created.job.id);
      finalizeAttempt(ctx, auditId, "success", null, created.job.id);
      return json({ job: viewForJob(detail.job, detail.runtime) }, { status: 201 });
    } catch (err) {
      finalizeAttempt(
        ctx,
        auditId,
        "failure",
        err instanceof WebDaemonError ? err.code : "internal",
      );
      return daemonErrorResponse(err);
    }
  }

  if (pathname.startsWith("/api/jobs/") && request.method === "POST") {
    const suffixes = [
      { suffix: "/tell", operation: "job.tell" as const },
      { suffix: "/stop", operation: "job.stop" as const },
      { suffix: "/kill", operation: "job.kill" as const },
    ];
    const matched = suffixes.find((entry) => pathname.endsWith(entry.suffix));
    if (!matched) {
      return json({ error: "not found" }, { status: 404, headers: getSecurityHeaders() });
    }

    const sessionHash = authenticatedSessionHash(ctx, cookies);
    if (!sessionHash) {
      return errorJson("unauthorized", "unauthorized", 401);
    }
    ctx.authStore.touchSession(sessionHash);

    const csrfHeader = request.headers.get("x-csrf-token");
    const jobId = readJobIdFromPath(pathname, matched.suffix);
    if (!jobId) {
      return errorJson("bad_request", "job id must not be empty", 400);
    }

    if (matched.operation === "job.tell") {
      const raw = (await request.json().catch(() => ({}))) as { message?: unknown; body?: unknown };
      const body =
        typeof raw.message === "string"
          ? raw.message.trim()
          : typeof raw.body === "string"
            ? raw.body.trim()
            : "";
      const requestSummary = summarizeTellRequest(body);
      const auditId = recordAttempt(ctx, sessionHash, matched.operation, jobId, requestSummary);
      if (auditId === null) {
        return errorJson("internal", "audit write failed", 500);
      }
      if (!csrfMatches(cookies, csrfHeader)) {
        finalizeAttempt(ctx, auditId, "failure", "csrf_mismatch");
        return errorJson("csrf_mismatch", "csrf token mismatch", 403);
      }
      if (!body) {
        finalizeAttempt(ctx, auditId, "failure", "bad_request");
        return errorJson("bad_request", "message body must not be empty", 400);
      }
      if (Buffer.byteLength(body, "utf8") > 64 * 1024) {
        finalizeAttempt(ctx, auditId, "failure", "bad_request");
        return errorJson("bad_request", "message body must not exceed 64 KiB", 400);
      }

      try {
        const result = await ctx.daemon.tellJob(jobId, body);
        finalizeAttempt(ctx, auditId, "success");
        return json(result);
      } catch (err) {
        finalizeAttempt(
          ctx,
          auditId,
          "failure",
          err instanceof WebDaemonError ? err.code : "internal",
        );
        return daemonErrorResponse(err);
      }
    }

    await request.json().catch(() => ({}));
    const requestSummary = summarizeEmptyRequest();
    const auditId = recordAttempt(ctx, sessionHash, matched.operation, jobId, requestSummary);
    if (auditId === null) {
      return errorJson("internal", "audit write failed", 500);
    }
    if (!csrfMatches(cookies, csrfHeader)) {
      finalizeAttempt(ctx, auditId, "failure", "csrf_mismatch");
      return errorJson("csrf_mismatch", "csrf token mismatch", 403);
    }

    try {
      const result =
        matched.operation === "job.stop"
          ? await ctx.daemon.stopJob(jobId)
          : await ctx.daemon.killJob(jobId);
      finalizeAttempt(ctx, auditId, "success");
      return json(result);
    } catch (err) {
      finalizeAttempt(
        ctx,
        auditId,
        "failure",
        err instanceof WebDaemonError ? err.code : "internal",
      );
      return daemonErrorResponse(err);
    }
  }

  if (pathname === "/api/jobs" && request.method === "GET") {
    if (!hasAuthenticatedSession(ctx, cookies)) {
      return json({ error: "unauthorized" }, { status: 401, headers: getSecurityHeaders() });
    }
    const jobs = await jobsWithRuntime(ctx);
    return json({ jobs });
  }

  if (pathname.startsWith("/api/jobs/") && request.method === "GET") {
    if (!hasAuthenticatedSession(ctx, cookies)) {
      return json({ error: "unauthorized" }, { status: 401, headers: getSecurityHeaders() });
    }
    const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
    const detail = await detailForJob(ctx, id);
    if (!detail) return json({ error: "not found" }, { status: 404 });
    return json(detail);
  }

  if (pathname === "/api/push/config" && request.method === "GET") {
    if (!hasAuthenticatedSession(ctx, cookies)) {
      return errorJson("unauthorized", "unauthorized", 401);
    }
    const publicKey = ctx.authStore.getVapidPublicKey();
    if (!publicKey) {
      return errorJson("not_ready", "VAPID keys not initialized", 503);
    }
    return json({ vapidPublicKey: publicKey, enabled: true });
  }

  if (pathname === "/api/push/subscribe" && request.method === "POST") {
    const sessionHash = authenticatedSessionHash(ctx, cookies);
    if (!sessionHash) return errorJson("unauthorized", "unauthorized", 401);
    ctx.authStore.touchSession(sessionHash);
    const csrfHeader = request.headers.get("x-csrf-token");
    if (!csrfMatches(cookies, csrfHeader)) {
      return errorJson("csrf_mismatch", "csrf token mismatch", 403);
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorJson("bad_request", "invalid JSON", 400);
    }
    const body = raw as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
    const p256dh = body.keys && typeof body.keys.p256dh === "string" ? body.keys.p256dh : null;
    const auth = body.keys && typeof body.keys.auth === "string" ? body.keys.auth : null;
    if (!endpoint) return errorJson("bad_request", "endpoint is required", 400);
    if (!p256dh) return errorJson("bad_request", "keys.p256dh is required", 400);
    if (!auth) return errorJson("bad_request", "keys.auth is required", 400);
    try {
      const u = new URL(endpoint);
      if (u.protocol !== "https:") {
        return errorJson("bad_request", "endpoint must use https", 400);
      }
    } catch {
      return errorJson("bad_request", "endpoint must be a valid URL", 400);
    }
    if (Buffer.byteLength(endpoint, "utf8") > 2048) {
      return errorJson("bad_request", "endpoint must not exceed 2 KiB", 400);
    }
    if (Buffer.byteLength(p256dh, "utf8") > 256) {
      return errorJson("bad_request", "p256dh must not exceed 256 bytes", 400);
    }
    if (Buffer.byteLength(auth, "utf8") > 64) {
      return errorJson("bad_request", "auth must not exceed 64 bytes", 400);
    }
    ctx.authStore.addPushSubscription({ endpoint, p256dh, auth });
    return json({ subscribed: true }, { status: 201 });
  }

  if (pathname === "/api/push/unsubscribe" && request.method === "POST") {
    const sessionHash = authenticatedSessionHash(ctx, cookies);
    if (!sessionHash) return errorJson("unauthorized", "unauthorized", 401);
    ctx.authStore.touchSession(sessionHash);
    const csrfHeader = request.headers.get("x-csrf-token");
    if (!csrfMatches(cookies, csrfHeader)) {
      return errorJson("csrf_mismatch", "csrf token mismatch", 403);
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return errorJson("bad_request", "invalid JSON", 400);
    }
    const body = raw as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
    if (!endpoint) return errorJson("bad_request", "endpoint is required", 400);
    try {
      const u = new URL(endpoint);
      if (u.protocol !== "https:") {
        return errorJson("bad_request", "endpoint must use https", 400);
      }
    } catch {
      return errorJson("bad_request", "endpoint must be a valid URL", 400);
    }
    ctx.authStore.removePushSubscription(endpoint);
    return json({ unsubscribed: true });
  }

  if (pathname.startsWith("/api/")) {
    return json({ error: "not found" }, { status: 404, headers: getSecurityHeaders() });
  }

  if (unsafe) {
    return json({ error: "method not allowed" }, { status: 405, headers: getSecurityHeaders() });
  }

  return json({ error: "not found" }, { status: 404, headers: getSecurityHeaders() });
}
