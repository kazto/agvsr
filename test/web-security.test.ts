import { describe, expect, it } from "bun:test";
import type { Job, JobRuntime } from "../src/protocol.ts";
import { deriveJobDisplayState, handleWebRequest } from "../src/web/routes.ts";
import { allowedHost, allowedOrigin, getSecurityHeaders } from "../src/web/security.ts";

describe("web security helpers", () => {
  it("enforces loopback host and origin allowlists", () => {
    const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
    expect(allowedHost("localhost:3000", hosts)).toBe(true);
    expect(allowedHost("127.0.0.1:8080", hosts)).toBe(true);
    expect(allowedHost("evil.example:3000", hosts)).toBe(false);

    const origins = new Set([
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
    ]);
    expect(allowedOrigin("http://localhost:3000", origins)).toBe(true);
    expect(allowedOrigin("http://127.0.0.1:8080", origins)).toBe(true);
    expect(allowedOrigin("http://localhost:9999", origins)).toBe(false);
    expect(allowedOrigin("http://evil.example", origins)).toBe(false);
  });

  it("emits hardening headers", () => {
    const headers = new Headers(getSecurityHeaders());
    expect(headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rejects an unapproved host at the route edge", async () => {
    const called = { auth: false, daemon: false };
    const ctx = {
      authStore: {
        getSession() {
          called.auth = true;
          return null;
        },
        touchSession() {
          called.auth = true;
        },
        deleteSession() {
          called.auth = true;
        },
        createSession() {
          called.auth = true;
          return null;
        },
        setBootstrapToken() {
          called.auth = true;
        },
        hasBootstrapToken() {
          called.auth = true;
          return false;
        },
        consumeBootstrapToken() {
          called.auth = true;
          return false;
        },
        close() {
          called.auth = true;
        },
      },
      daemon: {
        listJobs() {
          called.daemon = true;
          return Promise.resolve([]);
        },
        getJob() {
          called.daemon = true;
          return Promise.reject(new Error("should not be called"));
        },
        listMessages() {
          called.daemon = true;
          return Promise.resolve([]);
        },
        close() {
          called.daemon = true;
        },
      },
      startupToken: "token",
      startupTokenHash: "hash",
      hostAllowlist: new Set(["localhost", "127.0.0.1", "::1"]),
      originAllowlist: new Set(["localhost", "127.0.0.1", "::1"]),
      assets: { appJs: "", appCss: "" },
    };

    const response = await handleWebRequest(
      ctx as never,
      new Request("http://localhost/api/session", {
        headers: { host: "evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(called.auth).toBe(false);
    expect(called.daemon).toBe(false);
  });

  it("derives job display state from runtime", () => {
    const baseJob: Job = {
      id: "j1",
      goal: "demo",
      status: "running",
      cwd: process.cwd(),
      branch: null,
      worktree: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      workspace_id: null,
      workspace_name: null,
      caller_pane_id: null,
      herdr_session: null,
      design_approved_at: null,
      design_approved_refs: null,
    };
    const baseRuntime: JobRuntime = {
      in_flight: false,
      active_roles: [],
      last_activity_at: null,
      idle_ms: null,
    };

    expect(
      deriveJobDisplayState(baseJob, {
        in_flight: true,
        active_roles: ["supervisor"],
        last_activity_at: null,
        idle_ms: 1,
      }),
    ).toBe("in_flight");
    expect(
      deriveJobDisplayState(baseJob, {
        in_flight: false,
        active_roles: [],
        last_activity_at: null,
        idle_ms: 10,
      }),
    ).toBe("idle");
    expect(
      deriveJobDisplayState(baseJob, {
        in_flight: false,
        active_roles: [],
        last_activity_at: null,
        idle_ms: 10 * 60 * 1000,
      }),
    ).toBe("possibly_stalled");
    expect(deriveJobDisplayState({ ...baseJob, status: "done" }, baseRuntime)).toBe("terminal");
  });
});
