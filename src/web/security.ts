import { URL } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
type HeaderInit = ConstructorParameters<typeof Headers>[0];

export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    return trimmed.slice(1, trimmed.indexOf("]"));
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && trimmed.indexOf(":") === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

export function loopbackHosts(): Set<string> {
  return new Set(LOOPBACK_HOSTS);
}

export function allowedOrigin(origin: string, hosts: Set<string>): boolean {
  try {
    const url = new URL(origin);
    return hosts.has(normalizeHost(url.hostname));
  } catch {
    return false;
  }
}

export function allowedHost(host: string, hosts: Set<string>): boolean {
  return hosts.has(normalizeHost(host));
}

export function getSecurityHeaders(): HeaderInit {
  return {
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export function isStateChangingMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
