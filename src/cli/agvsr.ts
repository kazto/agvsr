#!/usr/bin/env bun
/**
 * `agvsr` — the thin CLI client (D6/D15). Connects to the daemon over local IPC
 * and issues one request. `agvsr daemon` runs the daemon itself in the foreground.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Client, DaemonNotRunningError, EndpointInUseError } from "../ipc/transport.ts";
import { ipcEndpoint } from "../paths.ts";
import { VERSION } from "../version.ts";
import type { Adapter } from "../config/team.ts";
import type { SkillName, SkillTarget } from "../config/skill-install.ts";
import type {
  Job,
  JobRuntime,
  JobUsage,
  Message,
  PingResult,
  PushFrame,
  Response,
  RoleSummary,
  RoleWorktree,
  UsageReport,
  UsageTotals,
} from "../protocol.ts";
import {
  assessWorktree,
  git,
  parseWorktreePorcelain,
  type CleanupClassification,
  type WorktreeAssessment,
  type WorktreeEntry,
} from "../git/cleanup.ts";
import { capturingRef } from "../git/checkpoint.ts";

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
  agvsr usage [job-id] [--since D] [--hourly] [--json]
                                    Show token/cost accounting, optionally over a rolling window
  agvsr cleanup [--apply] [--job ID | --all] [--base-ref REF]
                                    Report (or remove) job worktrees/branches safe to delete.
                                    --apply requires --job <id> (one job) or --all (every job).
                                    --base-ref overrides the "merged into main" comparison ref
                                    (default: local "main" — pass origin/main after a fetch if
                                    the local branch may be stale).
  agvsr web [--host H] [--port N] [--socket P]  Run the local web gateway
  agvsr doctor [--team F] [--json] [--probe]  Check adapter CLIs and auth; exit 0 if all pass
`;

function normalizeCwd(input: string): string {
  const home = process.env.HOME ?? homedir();
  const expanded =
    input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  return resolve(expanded);
}

/** Compact token count: 812, 12.3k, 1.24M — keeps the usage columns narrow. */
export function formatTokens(n: number): string {
  if (n < 1000) return Number.isInteger(n) ? String(n) : n.toFixed(1);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const HOUR_MS = 3_600_000;
const MAX_USAGE_WINDOW_MS = 30 * 24 * HOUR_MS;

/** Parse a compact positive duration accepted by `agvsr usage --since` (D40). */
export function parseUsageDuration(value: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new RangeError("--since must be a positive integer followed by m, h, or d");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? HOUR_MS : 24 * HOUR_MS;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError("--since must be positive");
  if (ms > MAX_USAGE_WINDOW_MS) throw new RangeError("--since must not exceed 30d");
  return ms;
}

export function formatUsageDuration(ms: number): string {
  if (ms % (24 * HOUR_MS) === 0) return `${ms / (24 * HOUR_MS)}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${ms / 60_000}m`;
}

export function resolveUsageWindow(since: string | undefined, hourly: boolean): number | undefined {
  const windowMs = since ? parseUsageDuration(since) : hourly ? 5 * HOUR_MS : undefined;
  if (hourly && windowMs !== undefined && windowMs < HOUR_MS) {
    throw new RangeError("--hourly requires --since of at least 1h");
  }
  return windowMs;
}

/**
 * Cost with an explicit "this is a floor" marker. A trailing `+` means at least one
 * turn in the group came from an adapter that reports no cost (codex/agy), so the
 * real figure is higher — printing a bare number there would be a lie (D32).
 */
export function formatCost(totals: UsageTotals): string {
  const base = `$${totals.cost_usd.toFixed(2)}`;
  return totals.cost_partial ? `${base}+` : base;
}

function usageTotalsLine(t: UsageTotals): string {
  const turns = Number.isInteger(t.turns) ? String(t.turns) : t.turns.toFixed(1);
  const parts = [
    `${turns} turns`,
    `in ${formatTokens(t.input_tokens)}`,
    `out ${formatTokens(t.output_tokens)}`,
    `cache_r ${formatTokens(t.cache_read_tokens)}`,
  ];
  if (t.reasoning_tokens > 0) parts.push(`reasoning ${formatTokens(t.reasoning_tokens)}`);
  parts.push(formatCost(t));
  return parts.join("  ");
}

/**
 * Usage block appended to `agvsr status <id>`.
 *
 * `usage` is optional because a daemon older than the accounting feature answers
 * `job.get` without it, and a CLI is routinely newer than the daemon it talks to
 * (the daemon only picks up new code on restart). Treat a missing payload the same
 * as an empty one rather than crashing the whole status command.
 */
export function formatJobUsage(usage: JobUsage | undefined): string[] {
  if (!usage?.totals || usage.totals.turns === 0) return ["usage: (none recorded)"];
  const lines = [`usage: ${usageTotalsLine(usage.totals)}`];
  for (const r of usage.by_role ?? []) {
    lines.push(
      `  ${r.role.padEnd(18)} ${r.adapter.padEnd(12)} ${r.model.padEnd(22)} ` +
        `${String(r.turns).padStart(4)} turns  ${formatCost(r).padStart(9)}`,
    );
  }
  return lines;
}

/** Full `agvsr usage` rendering: totals, then role and job breakdowns. */
export function formatUsageReport(report: UsageReport, jobId?: string): string[] {
  const lines: string[] = [];
  if (report.window) {
    lines.push(
      `WINDOW  last ${formatUsageDuration(report.window.window_ms)}  ` +
        `${report.window.start_at}..${report.window.end_at}`,
    );
  }
  lines.push(`${jobId ? `job ${jobId}` : "TOTAL"}  ${usageTotalsLine(report.totals)}`);
  if (report.rate_per_hour) lines.push(`RATE/h  ${usageTotalsLine(report.rate_per_hour)}`);
  if (report.totals.cost_partial) {
    lines.push("(+ = lower bound: codex/agy turns report tokens but no cost)");
  }

  lines.push("", "by role:");
  lines.push(
    `  ${"ROLE".padEnd(18)} ${"ADAPTER".padEnd(12)} ${"MODEL".padEnd(22)} ` +
      `${"TURNS".padStart(5)} ${"INPUT".padStart(8)} ${"OUTPUT".padStart(8)} ` +
      `${"CACHE_R".padStart(8)} ${"COST".padStart(9)}`,
  );
  for (const r of report.by_role) {
    lines.push(
      `  ${r.role.padEnd(18)} ${r.adapter.padEnd(12)} ${r.model.padEnd(22)} ` +
        `${String(r.turns).padStart(5)} ${formatTokens(r.input_tokens).padStart(8)} ` +
        `${formatTokens(r.output_tokens).padStart(8)} ` +
        `${formatTokens(r.cache_read_tokens).padStart(8)} ${formatCost(r).padStart(9)}`,
    );
  }

  if (report.buckets) {
    lines.push("", "by hour (UTC):");
    lines.push(
      `  ${"START".padEnd(24)} ${"END".padEnd(24)} ${"TURNS".padStart(7)} ` +
        `${"INPUT".padStart(8)} ${"OUTPUT".padStart(8)} ${"CACHE_R".padStart(8)} ` +
        `${"COST".padStart(9)}`,
    );
    for (const bucket of report.buckets) {
      lines.push(
        `  ${(bucket.start_at + (bucket.partial ? "*" : "")).padEnd(24)} ` +
          `${bucket.end_at.padEnd(24)} ${String(bucket.totals.turns).padStart(7)} ` +
          `${formatTokens(bucket.totals.input_tokens).padStart(8)} ` +
          `${formatTokens(bucket.totals.output_tokens).padStart(8)} ` +
          `${formatTokens(bucket.totals.cache_read_tokens).padStart(8)} ` +
          `${formatCost(bucket.totals).padStart(9)}`,
      );
    }
    if (report.buckets.some((bucket) => bucket.partial)) lines.push("  * partial hour");
  }

  if (!jobId) {
    lines.push("", "by job:");
    lines.push(
      `  ${"JOB".padEnd(36)} ${"STATUS".padEnd(11)} ${"TURNS".padStart(5)} ` +
        `${"COST".padStart(9)}  GOAL`,
    );
    for (const j of report.by_job) {
      lines.push(
        `  ${j.job_id.padEnd(36)} ${j.status.padEnd(11)} ${String(j.turns).padStart(5)} ` +
          `${formatCost(j).padStart(9)}  ${j.goal.split("\n")[0]}`,
      );
    }
  }
  return lines;
}

export function formatEmptyUsageMessage(report: UsageReport, jobId?: string): string {
  if (report.window) {
    const duration = formatUsageDuration(report.window.window_ms);
    return jobId
      ? `no accounted turns for job ${jobId} in the last ${duration}`
      : `no accounted turns in the last ${duration}`;
  }
  return jobId ? `no accounted turns for job ${jobId}` : "no accounted turns recorded yet";
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

/**
 * Poll until nothing answers at `endpoint`. `daemon.stop` acknowledges the request
 * before the old daemon has finished closing, and a daemon now refuses to take over
 * an endpoint that is still live — so restarting without waiting would race the old
 * process and leave no daemon running at all.
 */
export async function waitForEndpointFree(
  endpoint: string,
  options: {
    connect?: typeof Client.connect;
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const connect = options.connect ?? Client.connect;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() <= deadline) {
    if (!(await probeDaemon(endpoint, connect))) return true;
    await sleep(pollMs);
  }
  return false;
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
        if (!(await waitForEndpointFree(ipcEndpoint()))) {
          console.error(
            `the old daemon is still listening on ${ipcEndpoint()}; not starting a second one. ` +
              `It may be finishing an in-flight turn — retry in a moment.`,
          );
          process.exit(1);
        }
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
      let daemon: Awaited<ReturnType<typeof startDaemon>>;
      try {
        daemon = await startDaemon({
          teamFile: daemonOpts.team,
          pushNotifier: createPushNotifier(daemonStoreFile),
          // This process exists only to be the daemon, so an IPC stop must end it.
          exitOnStop: true,
        });
      } catch (e) {
        // Losing the race for the endpoint is an ordinary outcome now, not a crash.
        if (e instanceof EndpointInUseError) {
          console.error(e.message);
          process.exit(1);
        }
        throw e;
      }
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
      const params: {
        goal: string;
        cwd: string;
        id?: string;
        workspace_id?: string;
        caller_pane_id?: string;
        herdr_session?: string;
      } = { goal, cwd };
      if (values.id) params.id = values.id;
      // herdr mode (D29): detected from env, never required. Absent HERDR_ENV/
      // HERDR_WORKSPACE_ID, the job is submitted as standalone with no herdr fields.
      const herdrMode = process.env.HERDR_ENV === "1" && !!process.env.HERDR_WORKSPACE_ID;
      if (herdrMode) {
        params.workspace_id = process.env.HERDR_WORKSPACE_ID;
        if (process.env.HERDR_PANE_ID) params.caller_pane_id = process.env.HERDR_PANE_ID;
        if (process.env.HERDR_SESSION) params.herdr_session = process.env.HERDR_SESSION;
      }
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
          const { job, runtime, usage } = unwrap(
            // usage is optional on the wire: an older daemon does not send it.
            await c.request<{ job: Job; runtime: JobRuntime; usage?: JobUsage }>("job.get", {
              id: jobId,
            }),
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
          for (const line of formatJobUsage(usage)) console.log(line);
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

    case "usage": {
      const { values: usageOpts, positionals: usageArgs } = parseArgs({
        args: rest,
        options: {
          json: { type: "boolean", default: false },
          since: { type: "string" },
          hourly: { type: "boolean", default: false },
        },
        allowPositionals: true,
      });
      const jobId = usageArgs[0];
      const windowMs = resolveUsageWindow(usageOpts.since, usageOpts.hourly);
      await withClient(async (c) => {
        const params = {
          ...(jobId ? { job_id: jobId } : {}),
          ...(windowMs !== undefined ? { window_ms: windowMs } : {}),
          ...(usageOpts.hourly ? { bucket_ms: HOUR_MS } : {}),
        };
        const report = unwrap(await c.request<UsageReport>("usage.report", params));
        if (windowMs !== undefined && !report.window) {
          throw new Error("daemon does not support windowed usage; update and restart agvsrd");
        }
        if (usageOpts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (report.totals.turns === 0) {
          console.log(formatEmptyUsageMessage(report, jobId));
          return;
        }
        for (const line of formatUsageReport(report, jobId)) console.log(line);
      });
      return;
    }

    case "cleanup": {
      const { values: cleanupOpts } = parseArgs({
        args: rest,
        options: {
          apply: { type: "boolean", default: false },
          job: { type: "string" },
          all: { type: "boolean", default: false },
          "base-ref": { type: "string", default: "main" },
        },
        allowPositionals: false,
        strict: true,
      });

      // An unscoped `--apply` deletes worktrees/branches across every job in one
      // shot. That footgun is what turned a typo'd `--job` flag (which didn't
      // exist yet, so `parseArgs` threw) into a `||`-chained fallback that wiped
      // an unrelated job's worktrees along with the intended one. Require the
      // caller to say which scope they mean before anything destructive runs.
      if (cleanupOpts.apply && !cleanupOpts.job && !cleanupOpts.all) {
        console.error(
          "refusing to run --apply without a scope.\n" +
            "  pass --job <id>  to remove only that job's worktrees, or\n" +
            "  pass --all       to remove every safe-to-remove worktree across all jobs.",
        );
        process.exit(2);
      }

      const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
      if (!repoRoot.ok) {
        console.error("not inside a git repository");
        process.exit(2);
      }
      const mainWorktreePath = repoRoot.stdout;
      const baseRef = cleanupOpts["base-ref"];

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
        if (cleanupOpts.job && !jobs.some((j) => j.id === cleanupOpts.job)) {
          console.error(`no such job: ${cleanupOpts.job}`);
          process.exit(2);
        }
        const { roleWorktrees } = unwrap(
          await c.request<{ roleWorktrees: RoleWorktree[] }>("job.roleWorktrees"),
        );
        const jobsById = new Map(jobs.map((j) => [j.id, j]));

        // A job's own worktree merges toward `baseRef` (default "main", override
        // with --base-ref if the local main ref is stale relative to origin);
        // an instance worktree (D27) merges toward its owning job's own branch
        // instead — it can be fully reconciled into the job branch long before
        // the job itself is merged upstream by a human.
        interface Match {
          job: Job;
          baseRef: string;
        }
        const matchByWorktree = new Map<string, Match>();
        const matchByBranch = new Map<string, Match>();
        for (const j of jobs) {
          if (j.worktree) matchByWorktree.set(j.worktree, { job: j, baseRef });
          if (j.branch) matchByBranch.set(j.branch, { job: j, baseRef });
        }
        for (const rw of roleWorktrees) {
          const job = jobsById.get(rw.job_id);
          if (!job) continue; // orphaned instance record; entry falls through as ORPHAN below
          const instanceBaseRef = job.branch ?? baseRef;
          matchByWorktree.set(rw.worktree, { job, baseRef: instanceBaseRef });
          matchByBranch.set(rw.branch, { job, baseRef: instanceBaseRef });
        }

        const matchFor = (entry: WorktreeEntry): Match | undefined =>
          matchByWorktree.get(entry.path) ??
          (entry.branch ? matchByBranch.get(entry.branch) : undefined);

        const scopedEntries = cleanupOpts.job
          ? entries.filter((entry) => matchFor(entry)?.job.id === cleanupOpts.job)
          : entries;

        if (scopedEntries.length === 0) {
          console.log(`no worktrees found for job ${cleanupOpts.job}.`);
          return;
        }

        const assessments = scopedEntries.map((entry) => {
          const match = matchFor(entry);
          // A dirty worktree whose state is already parked in a checkpoint ref
          // (D46) is safe to remove — nothing is discarded with the directory.
          const parked = match ? capturingRef(entry.path, match.job.id) : null;
          return assessWorktree(
            entry,
            match?.job ?? null,
            mainWorktreePath,
            match?.baseRef,
            parked,
          );
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
            console.log(
              "(dry run — pass --apply, plus --job <id> or --all, to remove the safe-to-remove entries)",
            );
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

Environment:
  AGVSR_WEB_EXTRA_ORIGINS  Comma-separated extra Origins to accept on
                           state-changing requests (e.g. a public hostname
                           fronted by a reverse proxy you trust, such as a
                           Cloudflare Tunnel). Bare loopback origins are
                           always accepted regardless of this setting.
`);
        return;
      }

      const { startWebGateway } = await import("../web/server.ts");
      const extraOrigins = (process.env.AGVSR_WEB_EXTRA_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      const web = await startWebGateway({
        host: values.host,
        port: values.port ? Number(values.port) : undefined,
        socket: values.socket,
        extraOrigins,
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
          format: { type: "string" },
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
        console.log(`agvsr init — generate a team.yaml/team.toml without hand editing

Usage: agvsr init [options]

  -o, --output <path>   Write to this file (default: ./team.yaml or ./team.toml,
                        depending on --format)
      --stdout          Write to stdout instead of a file
  -f, --force           Overwrite the output file if it already exists
      --format <f>      Output format: yaml, toml (default: yaml)
      --roles <list>    Comma-separated role names (default: supervisor,design,implementation,qa)
      --adapter <a>     Default adapter for every role (default: claude-code)
      --model <m>       Default model for every role
      --role <spec>     Per-role override, repeatable. Form: name:adapter:model
      --no-comments     Emit bare output without header/hooks comments
  -h, --help            Show this help

Run \`agvsr skill install\` separately (once, globally) to install the
bundled skill and /agvsr command.
`);
        return;
      }

      const {
        buildTeamYaml,
        buildTeamToml,
        resolveRoleSpecs,
        DEFAULT_ROLES,
        BUNDLED_CHARTER_ROLES,
        InitError,
      } = await import("../config/init.ts");

      const format = initOpts.format ?? "yaml";
      if (format !== "yaml" && format !== "toml") {
        console.error(`unknown --format "${format}". Valid formats: yaml, toml`);
        process.exit(1);
      }

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

      const build = format === "toml" ? buildTeamToml : buildTeamYaml;
      let output: string;
      try {
        output = build({ roles, comments: !initOpts["no-comments"] });
      } catch (err) {
        if (err instanceof InitError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

      if (initOpts.stdout) {
        process.stdout.write(output);
        return;
      }

      const defaultName = format === "toml" ? "team.toml" : "team.yaml";
      const outputPath = resolve(initOpts.output ?? defaultName);

      if (!initOpts.force && existsSync(outputPath)) {
        console.error(`${outputPath} already exists; pass --force to overwrite`);
        process.exit(1);
      }

      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output, "utf8");

      console.log(`wrote ${outputPath}`);
      return;
    }

    case "skill": {
      const { values: skillOpts, positionals: skillArgs } = parseArgs({
        args: rest,
        options: {
          skill: { type: "string", multiple: true },
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
        console.log(`agvsr skill install — install bundled skills + their commands

Usage: agvsr skill install [options]

      --skill <s>       Skill(s) to install: agvsr, self-improve.
                        Repeatable or comma-separated. Default: agvsr.
      --target <t>      Agent integration target(s): claude, gemini, codex
                        Repeatable or comma-separated. Default: claude.
                        Installs each skill for every target, plus its
                        command for claude/gemini where one exists (codex
                        has no custom-command mechanism; the agvsr skill has
                        no command for codex either — invoke skills there
                        with $<name> or browse via /skills instead).
      --project <dir>   Install into <dir> instead of the global location
                        (default: global, e.g. ~/.claude/skills/agvsr/SKILL.md).
                        Codex always installs globally to
                        $CODEX_HOME/skills/<name>/SKILL.md or
                        ~/.codex/skills/<name>/SKILL.md, ignoring --project.
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
        parseSkillNames,
        parseSkillTargets,
        resolveSkillTargetPath,
        readBundledSkillSource,
        resolveCommandTargetPath,
        readBundledCommandSource,
        SkillInstallError,
      } = await import("../config/skill-install.ts");

      const asArray = (v: string | string[] | undefined) =>
        v === undefined ? undefined : Array.isArray(v) ? v : [v];

      let skillNames: SkillName[];
      let targets: SkillTarget[];
      try {
        skillNames = parseSkillNames(asArray(skillOpts.skill));
        targets = parseSkillTargets(asArray(skillOpts.target));
      } catch (err) {
        if (err instanceof SkillInstallError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }

      const scope = skillOpts.project === undefined ? ("global" as const) : ("project" as const);
      const projectDir = skillOpts.project === undefined ? undefined : resolve(skillOpts.project);

      const skillDestinations = skillNames.flatMap((skill) =>
        targets.map((target) => ({
          skill,
          target,
          path: resolveSkillTargetPath(skill, target, scope, projectDir),
        })),
      );
      // Not every skill+target has a command (codex never does; self-improve
      // has none for any target); resolveCommandTargetPath/
      // readBundledCommandSource return null there.
      const commandDestinations = skillNames
        .flatMap((skill) =>
          targets.map((target) => ({
            skill,
            target,
            path: resolveCommandTargetPath(skill, target, scope, projectDir),
          })),
        )
        .filter(
          (dest): dest is { skill: SkillName; target: SkillTarget; path: string } =>
            dest.path !== null,
        );
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

      for (const { skill, path } of skillDestinations) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readBundledSkillSource(skill), "utf8");
        console.log(`installed ${path}`);
      }
      for (const { skill, target, path } of commandDestinations) {
        const contents = readBundledCommandSource(skill, target);
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
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    // node:util's parseArgs throws a raw ERR_PARSE_ARGS_* exception (unknown
    // option, missing value, ...) straight out of main() with no handling
    // below. Left uncaught, that surfaces as a Node stack trace on exit code
    // 1 — indistinguishable from any other failure, which is exactly what let
    // a mistyped flag silently trip a shell `||` fallback into a broader,
    // unintended command. Give it a clean message and its own exit code
    // instead; anything else still propagates so real bugs keep their trace.
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      console.error(`${(err as Error).message}\n\nRun "agvsr --help" for usage.`);
      process.exit(2);
    }
    throw err;
  }
}
