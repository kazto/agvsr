import { Client, DaemonNotRunningError } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";

export interface DetachedDaemonOptions {
  teamFile?: string;
  endpoint?: string;
  bunExec?: string;
  scriptPath?: string;
  spawn?: typeof Bun.spawn;
  connect?: typeof Client.connect;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface DetachedDaemonSpawnResult {
  alreadyRunning: boolean;
  started: boolean;
}

function daemonArgs(teamFile?: string): string[] {
  return teamFile ? ["daemon", "--team", teamFile] : ["daemon"];
}

function spawnDetachedDaemon({
  bunExec,
  scriptPath,
  teamFile,
  spawn = Bun.spawn,
}: Required<Pick<DetachedDaemonOptions, "bunExec" | "scriptPath">> &
  Pick<DetachedDaemonOptions, "teamFile" | "spawn">): void {
  const child = spawn([bunExec, scriptPath, ...daemonArgs(teamFile)], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
}

async function probeDaemon(
  endpoint: string,
  connect: typeof Client.connect = Client.connect,
): Promise<boolean> {
  try {
    const client = await connect(endpoint);
    client.close();
    return true;
  } catch (err) {
    if (err instanceof DaemonNotRunningError) return false;
    throw err;
  }
}

async function waitForDaemon(
  endpoint: string,
  connect: typeof Client.connect = Client.connect,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  readyTimeoutMs = 3000,
  readyPollMs = 50,
): Promise<void> {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() <= deadline) {
    if (await probeDaemon(endpoint, connect)) return;
    await sleep(readyPollMs);
  }
  throw new Error(`daemon did not become ready at ${endpoint} within ${readyTimeoutMs}ms`);
}

export async function startDaemonDetached(
  options: DetachedDaemonOptions = {},
): Promise<DetachedDaemonSpawnResult> {
  const endpoint = options.endpoint ?? ipcEndpoint();
  const connect = options.connect ?? Client.connect;
  if (await probeDaemon(endpoint, connect)) return { alreadyRunning: true, started: false };

  const [bunExec, scriptPath] = process.argv as [string, string, ...string[]];
  spawnDetachedDaemon({
    bunExec: options.bunExec ?? bunExec,
    scriptPath: options.scriptPath ?? scriptPath,
    teamFile: options.teamFile,
    spawn: options.spawn,
  });
  await waitForDaemon(
    endpoint,
    connect,
    options.sleep,
    options.readyTimeoutMs,
    options.readyPollMs,
  );
  return { alreadyRunning: false, started: true };
}

export function restartDaemonDetached(options: {
  teamFile?: string;
  bunExec?: string;
  scriptPath?: string;
  spawn?: typeof Bun.spawn;
}): void {
  const [bunExec, scriptPath] = process.argv as [string, string, ...string[]];
  spawnDetachedDaemon({
    bunExec: options.bunExec ?? bunExec,
    scriptPath: options.scriptPath ?? scriptPath,
    teamFile: options.teamFile,
    spawn: options.spawn,
  });
}
