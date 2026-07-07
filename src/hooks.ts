/**
 * Event hook runner (D26). Fires user-configured shell commands on key daemon
 * events. Fire-and-forget: hook failures must never crash the daemon.
 *
 * The hook command is passed to `sh -c` (POSIX) / `cmd /c` (Windows) and
 * receives the event JSON object on stdin.
 */

export interface HookEvent {
  event: string;
  [key: string]: unknown;
}

export interface PushPayload {
  job_id: string;
  status: string;
}

export type PushNotifier = (payload: PushPayload) => void;

export const noopPushNotifier: PushNotifier = () => {};

export function fireHook(cmd: string, event: HookEvent): void {
  const shell = process.platform === "win32" ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];
  try {
    const proc = Bun.spawn(shell, {
      stdin: Buffer.from(JSON.stringify(event) + "\n"),
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  } catch {
    // Intentionally swallowed: hooks must not disrupt the daemon.
  }
}
