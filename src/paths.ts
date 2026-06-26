/**
 * Filesystem locations for agvsr. Cross-platform (D18 local-only IPC, D5 store).
 */
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const isWindows = process.platform === "win32";

/** Per-user config directory: ~/.config/agvsr (POSIX) or %APPDATA%/agvsr (Windows). */
export function configDir(): string {
  const base = isWindows
    ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "agvsr");
}

/** SQLite store path (D5/D13). */
export function storePath(): string {
  return process.env.AGVSR_STORE ?? join(configDir(), "inbox.sqlite");
}

/**
 * Local IPC endpoint (D18). On Windows this is a named pipe; on POSIX a unix
 * domain socket under the runtime dir. `node:net` accepts both as a `path`.
 */
export function ipcEndpoint(): string {
  if (process.env.AGVSR_SOCK) return process.env.AGVSR_SOCK;
  if (isWindows) return `\\\\.\\pipe\\agvsr-${userInfo().username}`;
  const runtime = process.env.XDG_RUNTIME_DIR ?? configDir();
  return join(runtime, "agvsrd.sock");
}

/** Ensure the config dir exists; returns it. */
export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
