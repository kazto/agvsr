#!/usr/bin/env bun
/**
 * `agvsr` — the thin CLI client (D6/D15). Connects to the daemon over local IPC
 * and issues one request. `agvsr daemon` runs the daemon itself in the foreground.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { Client, DaemonNotRunningError } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Adapter } from "../config/team.ts";
import type { SkillTarget } from "../config/skill-install.ts";
import type {
  Job,
  JobRuntime,
  Message,
  PingResult,
  PushFrame,
  Response,
  RoleSummary,
} from "../protocol.ts";

const USAGE = `agvsr ${VERSION}

Usage:
  agvsr init [options]              Generate a team.yaml without hand editing
  agvsr skill install [options]     Install the bundled skill + /agvsr command (once, globally by default)
  agvsr daemon [--team F]           Run the agvsrd daemon in the foreground
  agvsr daemon start [--team F]     Start the daemon in the background
  agvsr daemon stop                 Stop the running daemon gracefully
  agvsr daemon restart [--team F]   Restart the daemon (optionally with a new team file)
  agvsr ping                        Check the daemon is up
  agvsr job "<goal>" [--cwd D] [--id ID]  Submit a job (D is the target repo, default: cwd)
  agvsr status [job-id]             List jobs, or show one job with recent audit state
  agvsr logs <job-id> [-f]          Show audit messages for a job
  agvsr watch [--all] [--poll N]    Stream role messages across all running jobs in real time
  agvsr tell <job-id> "<message>"   Send a message to the supervisor of a running job
  agvsr stop <job-id>               Stop a running job gracefully (mark failed)
  agvsr kill <job-id>               Kill a running job immediately (mark interrupted)
  agvsr wait <job-id>... [--poll-sec N] [--timeout-sec N]
                                    Block until each job needs approval or finishes
  agvsr reload                      Reload team.yaml without restarting the daemon
  agvsr team                        Show configured roles
  agvsr cleanup [--apply]           Report (or remove) job worktrees/branches safe to delete
  agvsr web [--host H] [--port N] [--socket P]  Run the local web gateway
  agvsr doctor [--team F] [--json] [--probe]  Check adapter CLIs and auth; exit 0 if all pass
`;

function normalizeCwd(input: string): string {
  const home = process.env.HOME ?? homedir();
  const expanded =
    input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  return resolve(expanded);
}

/** Compact human duration: 45s, 12m, 1h03m. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Render live execution state next to a running job's status so the user can
 * tell "actively working" from "idle/stalled". Empty for terminal statuses.
 */
export function formatRuntime(job: Job, rt: JobRuntime): string {
  if (job.status !== "running") return "";
  const idle = rt.idle_ms != null ? `, idle ${formatDuration(rt.idle_ms)}` : "";
  if (!rt.in_flight) {
    return ` — no in-flight turn${idle} (possibly stalled)`;
  }
  const roleDetails = rt.active_roles
    .map((role) => {
      const parts: string[] = [role];
      const remaining = rt.hard_remaining_ms?.[role];
      if (remaining !== undefined) parts.push(`budget ${formatDuration(remaining)} left`);
      const idleSince = rt.idle_since_progress_ms?.[role];
      if (idleSince !== undefined) parts.push(`last progress ${formatDuration(idleSince)} ago`);
      return parts.join(", ");
    })
    .join("; ");
  return ` — working: ${roleDetails}${idle}`;
}

/**
 * Parse the --poll N argument for `agvsr watch`.
 * Returns the clamped poll interval in ms, or throws RangeError for invalid input.
 */
export function parsePollMs(raw: string | undefined): number {
  if (raw === undefined) return 2000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`--poll must be a positive finite number, got: ${raw}`);
  }
  return Math.max(500, n);
}

function formatMessageKind(kind: Message["kind"]): string {
  if (kind !== "note") return kind;
  return process.stdout.isTTY ? "\x1b[2m[note]\x1b[0m" : "[note]";
}

// Render a single `agvsr watch` message item. `withDelimiter` inserts the dim
// `---` separator that goes before every message after the first. Kept as a
// pure function so the delimiter behaviour can be unit-tested without spawning
// a live watch subprocess.
export function renderWatchMessage(
  jobId: string,
  m: Message,
  opts: { withDelimiter: boolean; tty?: boolean },
): string {
  const dim = (s: string): string => (opts.tty ? `\x1b[2m${s}\x1b[0m` : s);
  const ts = new Date(m.created_at).toLocaleTimeString("en-US", { hour12: false });
  const refs = m.refs ? ` refs=${m.refs}` : "";
  const header = `[${jobId.slice(0, 8)}] ${ts}  ${formatMessageKind(m.kind)} ${m.from_role} -> ${m.to_role}${refs}`;
  const lines: string[] = [];
  if (opts.withDelimiter) lines.push(dim("---"));
  lines.push(header, m.body, "");
  return lines.join("\n");
}

// Build the `agvsr watch` worker-liveness line, reusing `formatRuntime` so the
// wording matches `agvsr status`. Pure so it can be unit-tested in-process.
export function formatWatchHeartbeatLine(
  job: Job,
  runtime: JobRuntime,
  shortId: (id: string) => string,
): string {
  return `~ heartbeat [${shortId(job.id)}] ${job.status}${formatRuntime(job, runtime)}`;
}

// `agvsr wait` — the design-approval gate, the implementation-crash decision
// gate, and the commit-gate all converge on the same shape: daemon/supervisor
// addressing the human directly (to_role "user"), expecting a reply via
// `agvsr tell`. Used to detect "this job needs a human" without parsing
// human-readable `agvsr status` text.
function isApprovalRequest(m: Message): boolean {
  return m.to_role === "user" && (m.kind === "escalation" || m.kind === "message");
}

function truncateOneLine(s: string, max = 240): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function waitPollOnce(
  c: Client,
  jobId: string,
): Promise<{ job: Job; lastMessage: Message | null }> {
  const jobRes = await c.request<{ job: Job; runtime: JobRuntime }>("job.get", { id: jobId });
  if (!jobRes.ok) throw new Error(`job.get ${jobId}: ${jobRes.error.message}`);
  const msgRes = await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId });
  if (!msgRes.ok) throw new Error(`msg.list ${jobId}: ${msgRes.error.message}`);
  const messages = msgRes.result.messages;
  const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : null;
  return { job: jobRes.result.job, lastMessage };
}

// `agvsr cleanup` — cross-reference the daemon's own `job.list` records
// (exact `branch`/`worktree` fields recorded at job creation, see
// `Store.createJob`) against `git worktree list --porcelain`'s own (path,
// branch) pairs, matched by exact string equality. Never re-derive the
// branch-naming convention by hand: doing so once (matching an 8-char branch
// prefix against job ids) mis-classified nearly every real job as orphaned.
interface WorktreeEntry {
  path: string;
  branch: string | null; // null for detached HEAD worktrees
}

type CleanupClassification = "KEEP" | "SAFE_TO_REMOVE" | "NEEDS_REVIEW";

interface WorktreeAssessment {
  entry: WorktreeEntry;
  job: Job | null;
  dirty: boolean;
  aheadOfMain: number | null; // null if not resolvable (e.g. detached/no branch)
  classification: CleanupClassification;
  reason: string;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "" && current?.path) {
      entries.push({ path: current.path, branch: current.branch ?? null });
      current = null;
    }
  }
  if (current?.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

function assessWorktree(
  entry: WorktreeEntry,
  job: Job | null,
  mainWorktreePath: string,
): WorktreeAssessment {
  if (job?.status === "running") {
    return {
      entry,
      job,
      dirty: false,
      aheadOfMain: null,
      classification: "KEEP",
      reason: "job is running",
    };
  }

  const status = git(entry.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (!status.ok) {
    return {
      entry,
      job,
      dirty: true,
      aheadOfMain: null,
      classification: "NEEDS_REVIEW",
      reason: `git status failed: ${status.stderr || "unknown error"}`,
    };
  }
  const dirty = status.stdout.length > 0;

  let aheadOfMain: number | null = null;
  if (entry.branch) {
    const count = git(mainWorktreePath, ["rev-list", "--count", `main..${entry.branch}`]);
    aheadOfMain = count.ok ? Number(count.stdout) : null;
  }

  if (dirty) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: "uncommitted changes in the worktree",
    };
  }
  if (aheadOfMain === null) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: "could not determine commits-ahead-of-main (detached HEAD or missing branch)",
    };
  }
  if (aheadOfMain > 0) {
    return {
      entry,
      job,
      dirty,
      aheadOfMain,
      classification: "NEEDS_REVIEW",
      reason: `${aheadOfMain} commit(s) not yet merged into main`,
    };
  }
  return {
    entry,
    job,
    dirty,
    aheadOfMain,
    classification: "SAFE_TO_REMOVE",
    reason: job
      ? `job ${job.status}, clean, fully merged`
      : "orphaned (no job record), clean, fully merged",
  };
}

function formatWorktreeLine(a: WorktreeAssessment): string {
  const jobCol = a.job ? `${a.job.id}\t${a.job.status}` : "-\tORPHAN";
  const aheadCol = a.aheadOfMain === null ? "-" : String(a.aheadOfMain);
  return [
    a.entry.path,
    a.classification,
    jobCol,
    `dirty:${a.dirty ? "yes" : "no"}`,
    `ahead:${aheadCol}`,
    a.entry.branch ?? "(detached)",
    a.reason,
  ].join("\t");
}

function unwrap<T>(res: Response<T>): T {
  if (!res.ok) {
    console.error(`error [${res.error.code}]: ${res.error.message}`);
    process.exit(1);
  }
  return res.result;
}

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

function spawnDetachedDaemon(
  {
    bunExec,
    scriptPath,
    teamFile,
    spawn = Bun.spawn,
  }: Required<Pick<DetachedDaemonOptions, "bunExec" | "scriptPath">> &
    Pick<DetachedDaemonOptions, "teamFile" | "spawn">,
  stderr: "ignore" | "pipe" = "ignore",
): ReturnType<typeof Bun.spawn> {
  const child = spawn([bunExec, scriptPath, ...daemonArgs(teamFile)], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr,
  });
  child.unref();
  return child;
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
  childExit?: Promise<number>,
  childStderr?: Promise<string>,
): Promise<void> {
  let exitCode: number | null = null;
  childExit?.then(
    (code) => (exitCode = code),
    () => (exitCode = -1),
  );

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() <= deadline) {
    if (await probeDaemon(endpoint, connect)) return;
    if (exitCode !== null) {
      const stderr = (await childStderr)?.trim();
      const detail = stderr
        ? `:
${stderr}`
        : ".";
      throw new Error(`daemon process exited before becoming ready (exit ${exitCode})${detail}`);
    }
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
  const child = spawnDetachedDaemon(
    {
      bunExec: options.bunExec ?? bunExec,
      scriptPath: options.scriptPath ?? scriptPath,
      teamFile: options.teamFile,
      spawn: options.spawn,
    },
    "pipe",
  );
  const stderrText = child.stderr
    ? new Response(child.stderr as ReadableStream).text().catch(() => "")
    : Promise.resolve("");
  await waitForDaemon(
    endpoint,
    connect,
    options.sleep,
    options.readyTimeoutMs,
    options.readyPollMs,
    child.exited,
    stderrText,
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

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  let client: Client;
  try {
    client = await Client.connect(ipcEndpoint());
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case "daemon": {
      const { values: daemonOpts, positionals: daemonArgs } = parseArgs({
        args: rest,
        options: { team: { type: "string" } },
        allowPositionals: true,
      });
      const subCmd = daemonArgs[0];

      if (subCmd === "stop") {
        await withClient(async (c) => {
          unwrap(await c.request("daemon.stop"));
          console.log("daemon stopping");
        });
        return;
      }

      if (subCmd === "start") {
        const started = await startDaemonDetached({
          teamFile: daemonOpts.team,
        });
        if (started.alreadyRunning) {
          console.log("daemon already running");
        } else {
          console.log("daemon started");
        }
        return;
      }

      if (subCmd === "restart") {
        await withClient(async (c) => {
          unwrap(await c.request("daemon.stop"));
          console.log("daemon stopped, restarting...");
        });
        restartDaemonDetached({ teamFile: daemonOpts.team });
        console.log("daemon restarted");
        return;
      }

      if (subCmd) {
        console.error(`unknown daemon subcommand: ${subCmd}\n\n${USAGE}`);
        process.exit(1);
      }

      const { startDaemon } = await import("../daemon/daemon.ts");
      const { createPushNotifier } = await import("../web/push.ts");
      const { storePath: getStorePath } = await import("../paths.ts");
      const daemonStoreFile = process.env.AGVSR_STORE ?? getStorePath();
      const daemon = await startDaemon({
        teamFile: daemonOpts.team,
        pushNotifier: createPushNotifier(daemonStoreFile),
      });
      console.log(`agvsrd ${VERSION} listening on ${daemon.endpoint}`);
      const shutdown = async () => {
        await daemon.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "ping":
      await withClient(async (c) => {
        const r = unwrap(await c.request<PingResult>("ping"));
        console.log(`pong — agvsrd ${r.version}`);
      });
      return;

    case "job": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { cwd: { type: "string" }, id: { type: "string" } },
        allowPositionals: true,
      });
      const goal = positionals.join(" ").trim();
      if (!goal) {
        console.error('a goal is required, e.g. agvsr job "add a health endpoint"');
        process.exit(1);
      }
      const cwd = normalizeCwd(values.cwd ?? process.cwd());
      const params: { goal: string; cwd: string; id?: string } = { goal, cwd };
      if (values.id) params.id = values.id;
      await withClient(async (c) => {
        const { job } = unwrap(await c.request<{ job: Job }>("job.create", params));
        console.log(`job ${job.id} created (${job.status})`);
      });
      return;
    }

    case "status":
      await withClient(async (c) => {
        const jobId = rest[0];
        if (jobId) {
          const { job, runtime } = unwrap(
            await c.request<{ job: Job; runtime: JobRuntime }>("job.get", { id: jobId }),
          );
          const { messages } = unwrap(
            await c.request<{ messages: Message[] }>("msg.list", { job_id: jobId }),
          );
          const last = messages.at(-1);
          console.log(`${job.id}  ${job.status}${formatRuntime(job, runtime)}`);
          console.log(`goal: ${job.goal}`);
          console.log(`cwd: ${job.cwd}`);
          console.log(`worktree: ${job.worktree ?? "(none)"}`);
          console.log(`branch: ${job.branch ?? "(not set)"}`);
          console.log(`created_at: ${job.created_at}`);
          console.log(`updated_at: ${job.updated_at}`);
          console.log(`messages: ${messages.length}`);
          if (last) {
            console.log(`last_message_at: ${last.created_at}`);
            console.log(
              `last_message: ${formatMessageKind(last.kind)} ${last.from_role} -> ${last.to_role}`,
            );
            console.log(last.body);
          } else {
            console.log("last_message: (none)");
          }
          return;
        }

        const { jobs } = unwrap(await c.request<{ jobs: Job[] }>("job.list"));
        if (jobs.length === 0) {
          console.log("no jobs");
          return;
        }
        for (const j of jobs) {
          console.log(`${j.id}  ${j.status.padEnd(11)}  ${j.goal}`);
        }
      });
      return;

    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { follow: { type: "boolean", short: "f" } },
        allowPositionals: true,
      });
      const jobId = positionals[0];
      if (!jobId) {
        console.error("a job id is required, e.g. agvsr logs <job-id>");
        process.exit(1);
      }
      const print = (m: Message) => {
        const refs = m.refs ? ` refs=${m.refs}` : "";
        console.log(
          `[${m.created_at}] ${formatMessageKind(m.kind)} ${m.from_role} -> ${m.to_role}${refs}`,
        );
        console.log(m.body);
      };
      await withClient(async (c) => {
        const seen = new Set<string>();
        const { messages } = unwrap(
          await c.request<{ messages: Message[] }>("msg.list", {
            job_id: jobId,
            mark_read: true,
          }),
        );
        let count = 0;
        for (const m of messages) {
          seen.add(m.id);
          print(m);
          count++;
        }

        if (!values.follow) {
          if (count === 0) console.log("no messages");
          return;
        }

        // Server-push follow mode — no polling needed.
        c.onPush = (frame: PushFrame) => {
          if (frame.event !== "msg.new") return;
          const m = frame.data;
          if (m.job_id !== jobId || seen.has(m.id)) return;
          seen.add(m.id);
          print(m);
        };
        unwrap(await c.request("msg.watch", { job_id: jobId, mark_read: true }));
        await new Promise(() => {}); // block until the process is killed
      });
      return;
    }

    case "watch": {
      const { values: watchOpts } = parseArgs({
        args: rest,
        options: {
          all: { type: "boolean" },
          poll: { type: "string" },
        },
        allowPositionals: false,
      });
      let pollMs: number;
      try {
        pollMs = parsePollMs(watchOpts.poll);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
      }
      const showAll = watchOpts.all ?? false;

      await withClient(async (c) => {
        const watchedJobs = new Set<string>();
        const seen = new Set<string>();
        let printedMsg = false;

        const shortId = (id: string): string => id.slice(0, 8);

        const dim = (s: string): string => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

        const printMsg = (jobId: string, m: Message): void => {
          console.log(
            renderWatchMessage(jobId, m, {
              withDelimiter: printedMsg,
              tty: Boolean(process.stdout.isTTY),
            }),
          );
          printedMsg = true;
        };

        const printHeartbeat = async (job: Job): Promise<void> => {
          const getRes = await c.request<{ job: Job; runtime: JobRuntime }>("job.get", {
            id: job.id,
          });
          if (!getRes.ok) return;
          console.log(
            dim(formatWatchHeartbeatLine(getRes.result.job, getRes.result.runtime, shortId)),
          );
        };

        c.onPush = (frame: PushFrame): void => {
          if (frame.event !== "msg.new") return;
          const m = frame.data;
          if (seen.has(m.id)) return;
          seen.add(m.id);
          printMsg(m.job_id, m);
        };

        const subscribeToJob = async (job: Job): Promise<void> => {
          if (watchedJobs.has(job.id)) return;
          watchedJobs.add(job.id);
          console.log(dim(`+ watching [${shortId(job.id)}] ${job.status.padEnd(11)} ${job.goal}`));
          const listRes = await c.request<{ messages: Message[] }>("msg.list", {
            job_id: job.id,
          });
          if (listRes.ok) {
            for (const m of listRes.result.messages) {
              if (!seen.has(m.id)) {
                seen.add(m.id);
                printMsg(job.id, m);
              }
            }
          }
          await c.request("msg.watch", { job_id: job.id });
        };

        const poll = async (): Promise<void> => {
          const listRes = await c.request<{ jobs: Job[] }>("job.list");
          if (!listRes.ok) return;
          for (const job of listRes.result.jobs) {
            if (!showAll && job.status !== "running") continue;
            await printHeartbeat(job);
            await subscribeToJob(job);
          }
        };

        console.log(
          `agvsr watch  ${showAll ? "all jobs" : "running jobs only"}  (poll ${pollMs}ms, Ctrl-C to stop)`,
        );
        await poll();

        if (watchedJobs.size === 0) {
          const tip = showAll
            ? "no jobs found"
            : `no running jobs (use 'agvsr job "..."' to start one, or --all to include finished jobs)`;
          console.log(tip);
        }

        const timer = setInterval(() => {
          void poll();
        }, pollMs);

        await new Promise(() => {}); // block until the process is killed
        clearInterval(timer);
      });
      return;
    }

    case "tell": {
      const jobId = rest[0];
      const body = rest.slice(1).join(" ").trim();
      if (!jobId || !body) {
        console.error('usage: agvsr tell <job-id> "<message>"');
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.tell", { job_id: jobId, body }));
        console.log("message queued to supervisor");
      });
      return;
    }

    case "stop": {
      const jobId = rest[0];
      if (!jobId) {
        console.error("usage: agvsr stop <job-id>");
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.stop", { job_id: jobId }));
        console.log(`job ${jobId} stopped`);
      });
      return;
    }

    case "kill": {
      const jobId = rest[0];
      if (!jobId) {
        console.error("usage: agvsr kill <job-id>");
        process.exit(1);
      }
      await withClient(async (c) => {
        unwrap(await c.request("job.kill", { job_id: jobId }));
        console.log(`job ${jobId} killed`);
      });
      return;
    }

    case "wait": {
      const { values: waitOpts, positionals: jobIds } = parseArgs({
        args: rest,
        options: {
          "poll-sec": { type: "string", default: "30" },
          "timeout-sec": { type: "string", default: "3600" },
        },
        allowPositionals: true,
      });
      if (jobIds.length === 0) {
        console.error("usage: agvsr wait <job-id> [job-id ...] [--poll-sec N] [--timeout-sec N]");
        process.exit(1);
      }
      const pollMs = Math.max(1000, Number(waitOpts["poll-sec"]) * 1000);
      const deadline = Date.now() + Math.max(1000, Number(waitOpts["timeout-sec"]) * 1000);

      await withClient(async (c) => {
        const pending = new Set(jobIds);
        const seenMessageIds = new Set<string>();

        while (pending.size > 0 && Date.now() < deadline) {
          const settledThisRound: string[] = [];
          for (const jobId of pending) {
            const { job, lastMessage } = await waitPollOnce(c, jobId);

            if (job.status !== "running") {
              settledThisRound.push(jobId);
              console.log(`${jobId}\tTERMINAL\t${job.status}`);
              continue;
            }

            if (lastMessage && !seenMessageIds.has(lastMessage.id)) {
              seenMessageIds.add(lastMessage.id);
              if (isApprovalRequest(lastMessage)) {
                settledThisRound.push(jobId);
                console.log(
                  `${jobId}\tAPPROVAL_REQUEST\t${lastMessage.from_role} -> ${lastMessage.to_role}\t${truncateOneLine(lastMessage.body)}`,
                );
              }
            }
          }
          for (const jobId of settledThisRound) pending.delete(jobId);
          if (pending.size > 0) await Bun.sleep(pollMs);
        }

        if (pending.size > 0) {
          for (const jobId of pending) {
            console.log(`${jobId}\tTIMEOUT\tstill running, no approval request seen`);
          }
          process.exit(1);
        }
      });
      return;
    }

    case "reload":
      await withClient(async (c) => {
        const { roles } = unwrap(await c.request<{ roles: RoleSummary[] }>("reload"));
        console.log("team.yaml reloaded:");
        for (const r of roles) {
          console.log(`  ${r.name.padEnd(16)} ${r.adapter.padEnd(12)} ${r.model}`);
        }
      });
      return;

    case "team":
      await withClient(async (c) => {
        const { roles } = unwrap(await c.request<{ roles: RoleSummary[] }>("team.get"));
        for (const r of roles) {
          console.log(`${r.name.padEnd(16)} ${r.adapter.padEnd(12)} ${r.model}`);
        }
      });
      return;

    case "cleanup": {
      const { values: cleanupOpts } = parseArgs({
        args: rest,
        options: { apply: { type: "boolean", default: false } },
      });

      const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
      if (!repoRoot.ok) {
        console.error("not inside a git repository");
        process.exit(2);
      }
      const mainWorktreePath = repoRoot.stdout;

      const listRes = git(mainWorktreePath, ["worktree", "list", "--porcelain"]);
      if (!listRes.ok) {
        console.error(`git worktree list failed: ${listRes.stderr}`);
        process.exit(2);
      }
      const entries = parseWorktreePorcelain(listRes.stdout).filter(
        (e) => e.path !== mainWorktreePath,
      );

      if (entries.length === 0) {
        console.log("no job worktrees found (only the main checkout).");
        return;
      }

      await withClient(async (c) => {
        const { jobs } = unwrap(await c.request<{ jobs: Job[] }>("job.list"));
        const jobByWorktree = new Map(
          jobs.filter((j) => j.worktree).map((j) => [j.worktree as string, j]),
        );
        const jobByBranch = new Map(
          jobs.filter((j) => j.branch).map((j) => [j.branch as string, j]),
        );

        const assessments = entries.map((entry) => {
          const job =
            jobByWorktree.get(entry.path) ??
            (entry.branch ? (jobByBranch.get(entry.branch) ?? null) : null);
          return assessWorktree(entry, job, mainWorktreePath);
        });

        for (const a of assessments) console.log(formatWorktreeLine(a));

        const counts = {
          KEEP: 0,
          SAFE_TO_REMOVE: 0,
          NEEDS_REVIEW: 0,
        } satisfies Record<CleanupClassification, number>;
        for (const a of assessments) counts[a.classification]++;
        console.log(
          `\n${assessments.length} worktree(s): ${counts.KEEP} keep, ${counts.SAFE_TO_REMOVE} safe-to-remove, ${counts.NEEDS_REVIEW} need review`,
        );

        if (!cleanupOpts.apply) {
          if (counts.SAFE_TO_REMOVE > 0) {
            console.log("(dry run — pass --apply to remove the safe-to-remove entries)");
          }
          return;
        }

        for (const a of assessments) {
          if (a.classification !== "SAFE_TO_REMOVE") continue;
          if (a.entry.path === mainWorktreePath) continue; // belt-and-suspenders
          const removed = git(mainWorktreePath, ["worktree", "remove", "--force", a.entry.path]);
          if (!removed.ok) {
            console.error(`failed to remove worktree ${a.entry.path}: ${removed.stderr}`);
            continue;
          }
          if (a.entry.branch) git(mainWorktreePath, ["branch", "-D", a.entry.branch]);
          console.log(
            `removed ${a.entry.path}${a.entry.branch ? ` (branch ${a.entry.branch})` : ""}`,
          );
        }
        git(mainWorktreePath, ["worktree", "prune"]);
      });
      return;
    }

    case "web": {
      const { values } = parseArgs({
        args: rest,
        options: {
          host: { type: "string" },
          port: { type: "string" },
          socket: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
      });

      if (values.help) {
        console.log(`agvsr web — start the read-only local web gateway

Usage: agvsr web [options]

  --host <host>     TCP bind host (loopback only; default: 127.0.0.1)
  --port <port>     TCP bind port (default: random free port)
  --socket <path>   Unix socket path (default on POSIX: ${process.env.AGVSR_WEB_SOCK ?? "configDir()/web.sock"})
  -h, --help        Show this help
`);
        return;
      }

      const { startWebGateway } = await import("../web/server.ts");
      const web = await startWebGateway({
        host: values.host,
        port: values.port ? Number(values.port) : undefined,
        socket: values.socket,
      });
      console.log(`agvsr web listening on ${web.endpoint}`);
      console.log(`startup token: ${web.startupToken}`);
      const shutdown = async () => {
        await web.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "init": {
      const { values: initOpts } = parseArgs({
        args: rest,
        options: {
          output: { type: "string", short: "o" },
          stdout: { type: "boolean" },
          force: { type: "boolean", short: "f" },
          roles: { type: "string" },
          adapter: { type: "string" },
          model: { type: "string" },
          role: { type: "string", multiple: true },
          "no-comments": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: false,
        strict: true,
      });

      if (initOpts.help) {
        console.log(`agvsr init — generate a team.yaml without hand editing

Usage: agvsr init [options]

  -o, --output <path>   Write to this file (default: ./team.yaml)
      --stdout          Write to stdout instead of a file
  -f, --force           Overwrite the output file if it already exists
      --roles <list>    Comma-separated role names (default: supervisor,design,implementation,qa)
      --adapter <a>     Default adapter for every role (default: claude-code)
      --model <m>       Default model for every role
      --role <spec>     Per-role override, repeatable. Form: name:adapter:model
      --no-comments     Emit bare YAML without header/hooks comments
  -h, --help            Show this help

Run \`agvsr skill install\` separately (once, globally) to install the
bundled skill and /agvsr command.
`);
        return;
      }

      const { buildTeamYaml, resolveRoleSpecs, DEFAULT_ROLES, BUNDLED_CHARTER_ROLES, InitError } =
        await import("../config/init.ts");

      const VALID_ADAPTERS = ["claude-code", "codex", "agy"] as const;

      const defaultAdapter = (initOpts.adapter ?? "claude-code") as Adapter;
      if (!(VALID_ADAPTERS as readonly string[]).includes(defaultAdapter)) {
        console.error(
          `unknown adapter "${defaultAdapter}". Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
        );
        process.exit(1);
      }

      const roleOverrides = new Map<string, { adapter?: Adapter; model?: string }>();
      for (const rawSpec of initOpts.role ?? []) {
        const parts = rawSpec.split(":");
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
          console.error(`invalid --role spec "${rawSpec}": expected name:adapter:model`);
          process.exit(1);
        }
        const [roleName, roleAdapter, roleModel] = parts as [string, string, string];
        if (!(VALID_ADAPTERS as readonly string[]).includes(roleAdapter)) {
          console.error(
            `unknown adapter "${roleAdapter}" in --role "${rawSpec}". Valid adapters: ${VALID_ADAPTERS.join(", ")}`,
          );
          process.exit(1);
        }
        roleOverrides.set(roleName, { adapter: roleAdapter as Adapter, model: roleModel });
      }

      const roleNames = initOpts.roles
        ? initOpts.roles
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean)
        : [...DEFAULT_ROLES];

      if (!roleNames.includes("supervisor")) {
        process.stderr.write(
          'notice: "supervisor" was not in --roles list; prepending it automatically\n',
        );
        roleNames.unshift("supervisor");
      }

      for (const r of roleNames) {
        if (!BUNDLED_CHARTER_ROLES.has(r)) {
          process.stderr.write(
            `warning: role "${r}" has no bundled charter. Add "charter" or "charter_append" in team.yaml before running jobs.\n`,
          );
        }
      }

      const roles = resolveRoleSpecs({
        roleNames,
        defaultAdapter,
        defaultModel: initOpts.model,
        roleOverrides,
      });

      let yaml: string;
      try {
        yaml = buildTeamYaml({ roles, comments: !initOpts["no-comments"] });
      } catch (err) {
        if (err instanceof InitError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

      if (initOpts.stdout) {
        process.stdout.write(yaml);
        return;
      }

      const outputPath = resolve(initOpts.output ?? "team.yaml");

      if (!initOpts.force && existsSync(outputPath)) {
        console.error(`${outputPath} already exists; pass --force to overwrite`);
        process.exit(1);
      }

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, yaml, "utf8");

      console.log(`wrote ${outputPath}`);
      return;
    }

    case "skill": {
      const { values: skillOpts, positionals: skillArgs } = parseArgs({
        args: rest,
        options: {
          target: { type: "string", multiple: true },
          project: { type: "string" },
          force: { type: "boolean", short: "f" },
          help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: true,
      });
      const subCmd = skillArgs[0];

      if (skillOpts.help || subCmd === undefined) {
        console.log(`agvsr skill install — install the bundled skill + /agvsr command

Usage: agvsr skill install [options]

      --target <t>      Agent integration target(s): claude, gemini, codex
                        Repeatable or comma-separated. Default: claude.
                        Installs the skill for every target, plus a /agvsr
                        command for claude and gemini (codex has no custom-
                        command mechanism; invoke the skill there with
                        $agvsr or browse via /skills instead).
      --project <dir>   Install into <dir> instead of the global location
                        (default: global, e.g. ~/.claude/skills/agvsr/SKILL.md).
                        Codex always installs globally to
                        $CODEX_HOME/skills/agvsr/SKILL.md or
                        ~/.codex/skills/agvsr/SKILL.md, ignoring --project.
  -f, --force           Overwrite existing skill/command files
  -h, --help            Show this help
`);
        return;
      }

      if (subCmd !== "install") {
        console.error(`unknown skill subcommand: ${subCmd}\n\n${USAGE}`);
        process.exit(1);
      }

      const {
        parseSkillTargets,
        resolveSkillTargetPath,
        readBundledSkillSource,
        resolveCommandTargetPath,
        readBundledCommandSource,
        SkillInstallError,
      } = await import("../config/skill-install.ts");

      const rawTargets = skillOpts.target;
      let targets: SkillTarget[];
      try {
        targets = parseSkillTargets(
          rawTargets === undefined
            ? undefined
            : Array.isArray(rawTargets)
              ? rawTargets
              : [rawTargets],
        );
      } catch (err) {
        if (err instanceof SkillInstallError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

      const scope = skillOpts.project === undefined ? ("global" as const) : ("project" as const);
      const projectDir = skillOpts.project === undefined ? undefined : resolve(skillOpts.project);

      const skillContents = readBundledSkillSource();
      const skillDestinations = targets.map((target) => ({
        target,
        path: resolveSkillTargetPath(target, scope, projectDir),
      }));
      // Not every target has a custom-command mechanism (codex does not);
      // resolveCommandTargetPath/readBundledCommandSource return null there.
      const commandDestinations = targets
        .map((target) => ({ target, path: resolveCommandTargetPath(target, scope, projectDir) }))
        .filter((dest): dest is { target: SkillTarget; path: string } => dest.path !== null);
      const intendedPaths = [
        ...skillDestinations.map((dest) => dest.path),
        ...commandDestinations.map((dest) => dest.path),
      ];

      if (!skillOpts.force) {
        const existing = intendedPaths.find((path) => existsSync(path));
        if (existing) {
          console.error(`${existing} already exists; pass --force to overwrite`);
          process.exit(1);
        }
      }

      for (const { path } of skillDestinations) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, skillContents, "utf8");
        console.log(`installed ${path}`);
      }
      for (const { target, path } of commandDestinations) {
        const contents = readBundledCommandSource(target);
        if (contents === null) continue; // unreachable given the filter above
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents, "utf8");
        console.log(`installed ${path}`);
      }

      return;
    }

    case "doctor": {
      const { values } = parseArgs({
        args: rest,
        options: {
          team: { type: "string" },
          json: { type: "boolean" },
          probe: { type: "boolean" },
        },
        allowPositionals: false,
      });

      const [{ resolveTeamFile }, { runDoctor, defaultDeps, reportHasFailures }] =
        await Promise.all([import("../config/team.ts"), import("../doctor.ts")]);

      const teamFile = resolveTeamFile(values.team);
      const report = await runDoctor(teamFile, defaultDeps(), { probe: values.probe ?? false });
      const hasFails = reportHasFailures(report);

      if (values.json) {
        console.log(
          JSON.stringify(
            {
              team_file: report.teamFile,
              ok: !hasFails,
              groups: report.groups,
            },
            null,
            2,
          ),
        );
      } else {
        for (const group of report.groups) {
          console.log(group.title);
          for (const check of group.checks) {
            const marker = check.level === "ok" ? "✓" : check.level === "warn" ? "~" : "✗";
            console.log(`  ${marker} ${check.label}: ${check.message}`);
          }
          console.log();
        }

        const allChecks = report.groups.flatMap((g) => g.checks);
        const failCount = allChecks.filter((c) => c.level === "fail").length;
        const warnCount = allChecks.filter((c) => c.level === "warn").length;
        const warnSuffix =
          warnCount > 0 ? `, ${warnCount} warning${warnCount !== 1 ? "s" : ""}` : "";

        if (!hasFails) {
          console.log(`all checks passed${warnSuffix}`);
        } else {
          console.log(`${failCount} failure${failCount !== 1 ? "s" : ""}${warnSuffix}`);
        }
      }

      if (hasFails) process.exit(1);
      return;
    }

    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE);
      return;

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
