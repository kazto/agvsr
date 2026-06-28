/**
 * agvsrd — the central daemon (D6). Owns the store, IPC server, message router,
 * and the per-job agent session registry used by the resume-invoke runtime.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { serve, type PushFn } from "../ipc/transport.ts";
import { provisionWorktree } from "../git/worktree.ts";
import { Store } from "./store.ts";
import { allowedTargets, loadTeam, SUPERVISOR, type TeamConfig } from "../config/team.ts";
import { ensureConfigDir, ipcEndpoint, resolveUserPath, storePath } from "../paths.ts";
import { VERSION } from "../version.ts";
import {
  composeCharter,
  driverFor,
  runTurn,
  type TurnEvent,
  type TurnResult,
} from "../adapters/index.ts";
import { validateTeamModels } from "../adapters/validate.ts";
import { fireHook, type HookEvent } from "../hooks.ts";
import type {
  Job,
  JobRuntime,
  Message,
  PushFrame,
  Request,
  Response,
  RoleSummary,
} from "../protocol.ts";
import type { Adapter } from "../config/team.ts";

function resolveTeam(file?: string): TeamConfig | null {
  const candidate = file ?? process.env.AGVSR_TEAM ?? join(process.cwd(), "team.yaml");
  if (!existsSync(candidate)) return null;
  return loadTeam(candidate);
}

function effectiveTeamFile(file?: string): string {
  return file ?? process.env.AGVSR_TEAM ?? join(process.cwd(), "team.yaml");
}

const ok = (id: string, result: unknown): Response => ({ id, type: "response", ok: true, result });
const err = (id: string, code: string, message: string): Response => ({
  id,
  type: "response",
  ok: false,
  error: { code, message },
});

export interface Daemon {
  endpoint: string;
  close(): Promise<void>;
}

export interface TurnDispatch {
  role: string;
  /** Adapter type from the job's team snapshot (D17). */
  adapter: string;
  /** Model string from the job's team snapshot (D17). */
  model: string;
  job: Job;
  message: string;
  sessionId: string | null;
  systemPrompt: string;
  env: Record<string, string>;
  /** AbortSignal wired to job.kill — set to abort when the job is forcefully killed. */
  signal?: AbortSignal;
  /** Effective working directory for agent execution: job.worktree if set, else job.cwd. */
  effectiveCwd: string;
  /** Resolved hard (wall-clock) timeout in ms. */
  hardTimeoutMs: number;
  /** Resolved idle (no-progress) timeout in ms, always <= hardTimeoutMs. */
  idleTimeoutMs: number;
  /** Called on each stdout line; lets the daemon track real progress time (Tier 2). */
  onProgress?: () => void;
}

export type TurnRunner = (dispatch: TurnDispatch) => Promise<TurnResult>;

export interface StartDaemonOptions {
  store?: Store;
  storeFile?: string;
  team?: TeamConfig | null;
  /** Path to team.yaml; overrides AGVSR_TEAM env var and the ./team.yaml default. */
  teamFile?: string;
  endpoint?: string;
  turnRunner?: TurnRunner;
  /** D17 fail-safe: mark stale running jobs interrupted when a daemon starts. */
  interruptRunningJobsOnStart?: boolean;
  /** Override hook runner for testing (default: fireHook). */
  hookRunner?: (cmd: string, event: HookEvent) => void;
  /** Override resolved PATH (default: query $SHELL login profile). */
  userPath?: string;
}

const DEFAULT_MAX_WORKER_FAILURES = 3;

/** Default idle (no-progress) timeout — mirrors the old 10 minute timeout feel. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Default hard (wall-clock) timeout — safety cap for long but progressing turns. */
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;

function parseTimeoutEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveTurnTimeouts(roleConfig: import("../config/team.ts").RoleConfig): {
  hardMs: number;
  idleMs: number;
} {
  const hardMs =
    roleConfig.hard_timeout_ms ??
    parseTimeoutEnv("AGVSR_TURN_HARD_TIMEOUT_MS") ??
    parseTimeoutEnv("AGVSR_TURN_TIMEOUT_MS") ??
    DEFAULT_HARD_TIMEOUT_MS;
  const idleRaw =
    roleConfig.idle_timeout_ms ??
    parseTimeoutEnv("AGVSR_TURN_IDLE_TIMEOUT_MS") ??
    DEFAULT_IDLE_TIMEOUT_MS;
  return { hardMs, idleMs: Math.min(idleRaw, hardMs) };
}

function maxWorkerFailures(): number {
  const raw = process.env.AGVSR_MAX_WORKER_FAILURES;
  if (!raw) return DEFAULT_MAX_WORKER_FAILURES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_WORKER_FAILURES;
}

const CONFIG_ERROR_PATTERNS: Record<Adapter, RegExp[]> = {
  "claude-code": [
    /issue with the selected model/i,
    /model .* not found/i,
    /unknown model/i,
    /invalid model/i,
    /invalid\/unsupported model/i,
    /unsupported model/i,
    /not a valid model/i,
    /model is not supported/i,
  ],
  codex: [
    /issue with the selected model/i,
    /model .* not found/i,
    /unknown model/i,
    /invalid model/i,
    /invalid\/unsupported model/i,
    /unsupported model/i,
    /not a valid model/i,
    /model is not supported/i,
  ],
  agy: [
    /issue with the selected model/i,
    /model .* not found/i,
    /unknown model/i,
    /invalid model/i,
    /invalid\/unsupported model/i,
    /unsupported model/i,
    /not a valid model/i,
    /model is not supported/i,
  ],
};

function tailText(text: string, maxBytes: number): string {
  if (!text) return "";
  return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
}

function isConfigError(adapter: Adapter, text: string): boolean {
  return CONFIG_ERROR_PATTERNS[adapter].some((pattern) => pattern.test(text));
}

function configErrorEscalation(
  role: string,
  adapter: Adapter,
  model: string,
  diagnostics: string,
): string {
  const bounded = tailText(diagnostics, 2048);
  return [
    `設定エラーの可能性: team.yaml の ${role}.model=${model} を確認`,
    `role=${role} adapter=${adapter} model=${model}`,
    bounded ? `diagnostics:\n${bounded}` : "diagnostics: (empty)",
  ].join("\n\n");
}

const DEFAULT_NO_PROGRESS_TURNS = 3;
const DEFAULT_LOOP_REPEAT_TURNS = 3;
const DEFAULT_MAX_LOOP_ESCALATIONS = 3;
const DEFAULT_STALL_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;

function noProgressTurns(): number {
  const raw = process.env.AGVSR_NO_PROGRESS_TURNS;
  if (!raw) return DEFAULT_NO_PROGRESS_TURNS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_NO_PROGRESS_TURNS;
}

function loopRepeatTurns(): number {
  const raw = process.env.AGVSR_LOOP_REPEAT_TURNS;
  if (!raw) return DEFAULT_LOOP_REPEAT_TURNS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LOOP_REPEAT_TURNS;
}

function maxLoopEscalations(): number {
  const raw = process.env.AGVSR_MAX_LOOP_ESCALATIONS;
  if (!raw) return DEFAULT_MAX_LOOP_ESCALATIONS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_LOOP_ESCALATIONS;
}

function stallTimeoutMs(): number {
  const raw = process.env.AGVSR_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_STALL_TIMEOUT_MS;
}

function toolUseFingerprint(events: TurnEvent[]): string {
  return events
    .filter((e): e is Extract<TurnEvent, { kind: "tool_use" }> => e.kind === "tool_use")
    .map((e) => `${e.name}:${JSON.stringify(e.input)}`)
    .join("|");
}

function defaultTurnRunner(): TurnRunner {
  return async ({
    role,
    adapter,
    model,
    effectiveCwd,
    message,
    sessionId,
    systemPrompt,
    env,
    signal,
    hardTimeoutMs,
    idleTimeoutMs,
    onProgress,
  }) => {
    const driver = driverFor(adapter as import("../config/team.ts").Adapter);
    return runTurn(
      driver,
      {
        role,
        adapter: adapter as import("../config/team.ts").Adapter,
        model,
        cwd: effectiveCwd,
        systemPrompt,
        env,
      },
      sessionId,
      message,
      { hardTimeoutMs, idleTimeoutMs, signal, onProgress },
    );
  };
}

function normalizeCwd(input: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(expanded);
}

function cwdError(cwd: string): string | null {
  try {
    return statSync(cwd).isDirectory() ? null : `cwd is not a directory: ${cwd}`;
  } catch (err) {
    return `cwd does not exist: ${cwd} (${(err as Error).message})`;
  }
}

function isAllowed(team: TeamConfig, from: string, to: string): boolean {
  if (from === "user") return to === SUPERVISOR;
  if (!team.roles[from]) return false;
  return allowedTargets(team, from).includes(to);
}

const debug = process.env.AGVSR_DEBUG
  ? (...args: unknown[]) => console.error("[agvsrd]", new Date().toISOString(), ...args.map(String))
  : () => {};

export async function startDaemon(options: StartDaemonOptions = {}): Promise<Daemon> {
  ensureConfigDir();
  const store = options.store ?? new Store(options.storeFile ?? storePath());
  const ownsStore = !options.store;
  const teamFile = effectiveTeamFile(options.teamFile);
  let team = options.team === undefined ? resolveTeam(options.teamFile) : options.team;
  const endpoint = options.endpoint ?? ipcEndpoint();
  let runner: TurnRunner | null = options.turnRunner ?? (team ? defaultTurnRunner() : null);
  const hookRun = options.hookRunner ?? fireHook;
  const userPath = options.userPath ?? (await resolveUserPath());
  debug("starting", { endpoint, pid: process.pid });

  const emitTeamModelWarnings = (currentTeam: TeamConfig, source: string): void => {
    for (const finding of validateTeamModels(currentTeam)) {
      debug(
        `team ${source} model warning: role=${finding.role} adapter=${finding.adapter} model=${finding.model} ${finding.message}${
          finding.hint ? ` | hint=${finding.hint}` : ""
        }`,
      );
    }
  };

  // Always reads current `team` so hooks update immediately after reload.
  const hook = (hookName: keyof NonNullable<TeamConfig["hooks"]>, event: HookEvent): void => {
    const cmd = team?.hooks?.[hookName];
    if (cmd) hookRun(cmd, event);
  };
  // Per-job team snapshots (D17): role config captured at job creation so
  // reload doesn't change adapter/model mid-job.
  const jobTeamSnapshots = new Map<string, TeamConfig>();
  if (options.interruptRunningJobsOnStart !== false) {
    for (const job of store.interruptRunningJobs()) {
      store.createMessage({
        job_id: job.id,
        from_role: "daemon",
        to_role: "user",
        kind: "failure",
        body: "Daemon started with this job still marked running; marked interrupted for fail-safe recovery.",
      });
    }
  }
  const sessions = new Map<string, Map<string, string | null>>();
  const failureCounts = new Map<string, Map<string, number>>();
  // Loop/no-progress watchdog state (D14)
  const noProgressCounts = new Map<string, Map<string, number>>();
  const loopFingerprints = new Map<string, Map<string, { fp: string; count: number }>>();
  const loopEscalationCounts = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();
  const pendingDispatches = new Set<Promise<void>>();
  const stallNotified = new Set<string>();
  // Turn-level timing maps keyed by "${jobId}:${role}" — exist only while in-flight.
  const turnStartedAt = new Map<string, number>();
  const turnHardMs = new Map<string, number>();
  const lastProgressAt = new Map<string, number>();
  const stallIntervalMs = Math.max(50, Math.min(stallTimeoutMs(), 60_000));
  let stallWatchdog: ReturnType<typeof setInterval> | null = null;
  // AbortControllers for in-flight dispatchRole calls, keyed by job id.
  const jobKillControllers = new Map<string, Set<AbortController>>();
  // Per-job push subscribers registered via msg.watch.
  const msgWatchers = new Map<string, Set<(frame: PushFrame) => boolean>>();
  // Deferred close trigger for daemon.stop.
  let doClose: () => Promise<void> = async () => {};

  if (team) {
    emitTeamModelWarnings(team, "startup");
  }

  const notifyWatchers = (msg: Message): void => {
    const set = msgWatchers.get(msg.job_id);
    if (!set || set.size === 0) return;
    const frame: PushFrame = { type: "push", event: "msg.new", data: msg };
    for (const watcher of set) {
      if (!watcher(frame)) set.delete(watcher); // prune dead connections
    }
  };

  // Wrapper so every message write also pushes to live watchers.
  const createMsg = (input: Parameters<Store["createMessage"]>[0]): Message => {
    const m = store.createMessage(input);
    notifyWatchers(m);
    return m;
  };

  const sessionFor = (jobId: string, role: string): string | null => {
    const cached = sessions.get(jobId)?.get(role);
    if (cached !== undefined) return cached;
    const persisted = store.getAgentSession(jobId, role);
    if (persisted) setSession(jobId, role, persisted);
    return persisted;
  };
  const setSession = (jobId: string, role: string, sessionId: string | null): void => {
    let byRole = sessions.get(jobId);
    if (!byRole) {
      byRole = new Map();
      sessions.set(jobId, byRole);
    }
    byRole.set(role, sessionId);
    if (sessionId) store.setAgentSession(jobId, role, sessionId);
  };

  const incrementFailure = (jobId: string, role: string): number => {
    let byRole = failureCounts.get(jobId);
    if (!byRole) {
      byRole = new Map();
      failureCounts.set(jobId, byRole);
    }
    const count = (byRole.get(role) ?? 0) + 1;
    byRole.set(role, count);
    return count;
  };

  const resetFailure = (jobId: string, role: string): void => {
    failureCounts.get(jobId)?.set(role, 0);
  };

  const byRole = <V>(map: Map<string, Map<string, V>>, jobId: string): Map<string, V> => {
    let m = map.get(jobId);
    if (!m) {
      m = new Map();
      map.set(jobId, m);
    }
    return m;
  };

  /**
   * Detects loop/no-progress patterns on a successful turn (D14 Tier1 signals).
   * Returns a human-readable escalation message if a signal fires, null otherwise.
   * Skips detection for agy (no structured tool_use events in stdout, D28).
   */
  const checkLoopSignal = (
    jobId: string,
    role: string,
    adapter: string,
    events: TurnEvent[],
  ): string | null => {
    if (adapter === "agy") return null;
    const toolUses = events.filter((e) => e.kind === "tool_use");

    if (toolUses.length === 0) {
      const count = (byRole(noProgressCounts, jobId).get(role) ?? 0) + 1;
      byRole(noProgressCounts, jobId).set(role, count);
      byRole(loopFingerprints, jobId).delete(role);
      if (count >= noProgressTurns()) {
        byRole(noProgressCounts, jobId).set(role, 0);
        return `${role} produced no tool_use events for ${count} consecutive turns (no-progress Tier1 watchdog signal, D14).`;
      }
    } else {
      byRole(noProgressCounts, jobId).set(role, 0);
      const fp = toolUseFingerprint(events);
      const prev = byRole(loopFingerprints, jobId).get(role);
      if (prev && prev.fp === fp) {
        const count = prev.count + 1;
        byRole(loopFingerprints, jobId).set(role, { fp, count });
        if (count >= loopRepeatTurns()) {
          byRole(loopFingerprints, jobId).set(role, { fp, count: 0 });
          return `${role} repeated identical tool calls for ${count} consecutive turns (loop Tier1 watchdog signal, D14).`;
        }
      } else {
        byRole(loopFingerprints, jobId).set(role, { fp, count: 1 });
      }
    }
    return null;
  };

  const dispatchRole = async (job: Job, role: string, message: string): Promise<void> => {
    if (!runner) throw new Error("no team.yaml configured");

    // Bail early if job is no longer running (killed or stopped while queued).
    const statusAtStart = store.getJob(job.id)?.status;
    if (statusAtStart !== "running") {
      debug("dispatch skipped (job not running)", { job: job.id, role, status: statusAtStart });
      return;
    }

    const jobTeam = jobTeamSnapshots.get(job.id) ?? team;
    if (!jobTeam) throw new Error("no team.yaml configured");
    const roleConfig = jobTeam.roles[role];
    if (!roleConfig) throw new Error(`no role ${role}`);

    const { hardMs, idleMs } = resolveTurnTimeouts(roleConfig);

    const messageCountBeforeTurn = store.listMessages(job.id).length;
    const sessionId = sessionFor(job.id, role);
    const effectiveCwd = job.worktree ?? job.cwd;
    const systemPrompt = sessionId
      ? ""
      : composeCharter(
          jobTeam,
          role,
          { jobId: job.id, cwd: effectiveCwd, branch: job.branch },
          { baseDir: dirname(process.env.AGVSR_TEAM ?? process.cwd()) },
        );

    // Register an AbortController so job.kill can terminate this turn.
    const ac = new AbortController();
    let acSet = jobKillControllers.get(job.id);
    if (!acSet) {
      acSet = new Set();
      jobKillControllers.set(job.id, acSet);
    }
    acSet.add(ac);

    // Register turn start for status visibility; cleaned up in finally.
    const key = `${job.id}:${role}`;
    turnStartedAt.set(key, Date.now());
    turnHardMs.set(key, hardMs);
    lastProgressAt.set(key, Date.now());

    debug("dispatch start", { job: job.id, role, message: message.slice(0, 80) });
    let result: Awaited<ReturnType<TurnRunner>>;
    try {
      result = await runner({
        role,
        adapter: roleConfig.adapter,
        model: roleConfig.model,
        job,
        effectiveCwd,
        message,
        sessionId,
        systemPrompt,
        signal: ac.signal,
        hardTimeoutMs: hardMs,
        idleTimeoutMs: idleMs,
        onProgress: () => lastProgressAt.set(key, Date.now()),
        env: {
          PATH: userPath,
          AGVSR_SOCK: endpoint,
          AGVSR_ROLE: role,
          AGVSR_JOB_ID: job.id,
          AGVSR_ALLOWED: allowedTargets(jobTeam, role).join(","),
          AGVSR_JOB_BRANCH: job.branch ?? "",
        },
      });
    } finally {
      acSet.delete(ac);
      if (acSet.size === 0) jobKillControllers.delete(job.id);
      turnStartedAt.delete(key);
      turnHardMs.delete(key);
      lastProgressAt.delete(key);
    }
    debug("dispatch done", { job: job.id, role, exitCode: result.outcome.exitCode });

    setSession(job.id, role, result.outcome.sessionId ?? sessionId);

    // If the job was killed or stopped during the turn, skip further processing.
    const statusMidTurn = store.getJob(job.id)?.status;
    if (statusMidTurn !== "running") {
      debug("dispatch post-kill, skipping result handling", { job: job.id, role });
      return;
    }

    const messagesFromTurn = store.listMessages(job.id).slice(messageCountBeforeTurn);
    const statusAfterTurn = store.getJob(job.id)?.status ?? job.status;
    const routedByRole = messagesFromTurn.some((m) => m.from_role === role);
    const finalText = result.outcome.finalText.trim();
    if (finalText) {
      createMsg({
        job_id: job.id,
        from_role: role,
        to_role: "daemon",
        kind: "note",
        body: finalText,
      });
    }

    if (
      role === SUPERVISOR &&
      result.outcome.exitCode === 0 &&
      statusAfterTurn === "running" &&
      finalText &&
      !routedByRole
    ) {
      const reason =
        "supervisor turn ended with assistant text but no agvsr tool call was recorded; " +
        "the text was saved to the audit log, but no work was routed and the job cannot progress.";
      store.setJobStatus(job.id, "failed");
      createMsg({
        job_id: job.id,
        from_role: "daemon",
        to_role: "user",
        kind: "failure",
        body: reason,
      });
      hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
      return;
    }

    if (
      role !== SUPERVISOR &&
      result.outcome.exitCode === 0 &&
      statusAfterTurn === "running" &&
      finalText &&
      !routedByRole
    ) {
      resetFailure(job.id, role);
      const body =
        `${role} turn ended with assistant text but no agvsr tool call was recorded; ` +
        "the text was saved to the audit log, but no work was routed. " +
        "Please inspect the final text and decide whether to continue, redirect, or fail the job.\n\n" +
        `Final text:\n${finalText}`;
      createMsg({
        job_id: job.id,
        from_role: "daemon",
        to_role: SUPERVISOR,
        kind: "escalation",
        body,
      });
      enqueueDispatch(job, SUPERVISOR, body);
      return;
    }

    if (result.outcome.exitCode !== 0) {
      if (role === SUPERVISOR || result.outcome.timedOut) {
        let reason: string;
        if (result.outcome.timedOut) {
          reason =
            result.outcome.timeoutKind === "idle"
              ? `${role} turn failed: no progress for ${idleMs}ms (no-progress timeout).`
              : `${role} turn failed: exceeded hard timeout ${hardMs}ms.`;
        } else {
          reason = `${role} turn failed.`;
        }
        store.setJobStatus(job.id, "failed");
        createMsg({
          job_id: job.id,
          from_role: "daemon",
          to_role: "user",
          kind: "failure",
          body: reason,
        });
        hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
      } else {
        const diagnostics = [result.outcome.stderrTail, finalText].filter(Boolean).join("\n");
        if (diagnostics && isConfigError(roleConfig.adapter, diagnostics)) {
          const body = configErrorEscalation(
            role,
            roleConfig.adapter,
            roleConfig.model,
            diagnostics,
          );
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: SUPERVISOR,
            kind: "escalation",
            body,
          });
          enqueueDispatch(job, SUPERVISOR, body);
          return;
        }
        const failures = incrementFailure(job.id, role);
        const threshold = maxWorkerFailures();
        if (failures >= threshold) {
          const reason = `${role} failed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).`;
          store.setJobStatus(job.id, "failed");
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: reason,
          });
          hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
        } else {
          const body = `${role} turn failed with exit code ${result.outcome.exitCode} (failure ${failures}/${threshold}). Supervisor must decide whether to retry, reassign, or fail the job.`;
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: SUPERVISOR,
            kind: "escalation",
            body,
          });
          enqueueDispatch(job, SUPERVISOR, body);
        }
      }
    } else {
      resetFailure(job.id, role);
      const loopMsg = checkLoopSignal(job.id, role, roleConfig.adapter, result.events);
      if (loopMsg) {
        const escalations = (loopEscalationCounts.get(job.id) ?? 0) + 1;
        loopEscalationCounts.set(job.id, escalations);
        const maxLoop = maxLoopEscalations();
        if (escalations >= maxLoop) {
          const reason = `${loopMsg} (${escalations} loop escalations reached threshold ${maxLoop}; Tier2 watchdog hard-fail).`;
          store.setJobStatus(job.id, "failed");
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: reason,
          });
          hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
        } else {
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: SUPERVISOR,
            kind: "escalation",
            body: loopMsg,
          });
          enqueueDispatch(job, SUPERVISOR, loopMsg);
        }
      } else {
        loopEscalationCounts.set(job.id, 0);
      }
    }
  };

  const enqueueDispatch = (job: Job, role: string, message: string): void => {
    const key = `${job.id}:${role}`;
    stallNotified.delete(job.id);
    const previous = inflight.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => dispatchRole(job, role, message))
      .catch((e) => {
        const message = (e as Error).message;
        if (role === SUPERVISOR) {
          store.setJobStatus(job.id, "failed");
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: message,
          });
          hook("on_job_failed", {
            event: "job_failed",
            job_id: job.id,
            goal: job.goal,
            reason: message,
          });
        } else {
          const failures = incrementFailure(job.id, role);
          const threshold = maxWorkerFailures();
          if (failures >= threshold) {
            const reason = `${role} crashed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).`;
            store.setJobStatus(job.id, "failed");
            createMsg({
              job_id: job.id,
              from_role: "daemon",
              to_role: "user",
              kind: "failure",
              body: reason,
            });
            hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
          } else {
            const body = `${role} turn crashed: ${message} (crash ${failures}/${threshold}). Supervisor must decide whether to retry, reassign, or fail the job.`;
            createMsg({
              job_id: job.id,
              from_role: "daemon",
              to_role: SUPERVISOR,
              kind: "escalation",
              body,
            });
            enqueueDispatch(job, SUPERVISOR, body);
          }
        }
      });
    inflight.set(key, next);
    pendingDispatches.add(next);
    next.finally(() => {
      pendingDispatches.delete(next);
      if (inflight.get(key) === next) inflight.delete(key);
    });
  };

  // Last error from a failed lazy-load attempt, surfaced in requireTeam messages.
  let teamLoadError: string | null = null;

  // Try to (re-)load team.yaml if team is currently null.
  const ensureTeam = (): void => {
    if (team) return;
    teamLoadError = null;
    try {
      const loaded = resolveTeam(options.teamFile);
      if (loaded) {
        team = loaded;
        if (!options.turnRunner) runner = defaultTurnRunner();
        emitTeamModelWarnings(loaded, "lazy-load");
        debug("team lazy-loaded", { teamFile });
      }
    } catch (e) {
      teamLoadError = (e as Error).message;
      debug("team lazy-load failed", { error: teamLoadError });
    }
  };

  const requireTeam = (id: string): Response | null => {
    ensureTeam();
    if (team) return null;
    const detail = teamLoadError
      ? `team.yaml is invalid: ${teamLoadError}`
      : `no team.yaml found at ${teamFile}. Create one with at least a '${SUPERVISOR}' role, or specify with --team or AGVSR_TEAM.`;
    return err(id, "no_team", detail);
  };

  /**
   * Live execution state for a job (B): does it have a turn queued or running,
   * and how long since the last audit activity. `inflight` holds a promise per
   * `${jobId}:${role}` while a turn is queued or running and is pruned on
   * completion, so its keys are the source of truth for "actively working".
   */
  const computeRuntime = (job: Job): JobRuntime => {
    const prefix = `${job.id}:`;
    const activeRoles = [...inflight.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    const last = store.listMessages(job.id).at(-1);
    const lastActivityAt = last?.created_at ?? job.updated_at;
    const activityIdleMs = lastActivityAt ? Date.now() - Date.parse(lastActivityAt) : null;

    const now = Date.now();
    const turnStartedAtRec: Record<string, string> = {};
    const hardRemainingRec: Record<string, number> = {};
    const lastProgressRec: Record<string, string> = {};
    const idleSinceProgressRec: Record<string, number> = {};

    for (const role of activeRoles) {
      const k = `${job.id}:${role}`;
      const started = turnStartedAt.get(k);
      const hard = turnHardMs.get(k);
      if (started !== undefined && hard !== undefined) {
        turnStartedAtRec[role] = new Date(started).toISOString();
        hardRemainingRec[role] = Math.max(0, started + hard - now);
      }
      const lastProg = lastProgressAt.get(k);
      if (lastProg !== undefined) {
        lastProgressRec[role] = new Date(lastProg).toISOString();
        idleSinceProgressRec[role] = now - lastProg;
      }
    }

    const hasTurnStarted = Object.keys(turnStartedAtRec).length > 0;
    const hasLastProgress = Object.keys(lastProgressRec).length > 0;

    return {
      in_flight: activeRoles.length > 0,
      active_roles: activeRoles,
      last_activity_at: lastActivityAt,
      idle_ms: activityIdleMs,
      ...(hasTurnStarted
        ? { turn_started_at: turnStartedAtRec, hard_remaining_ms: hardRemainingRec }
        : {}),
      ...(hasLastProgress
        ? { last_progress_at: lastProgressRec, idle_since_progress_ms: idleSinceProgressRec }
        : {}),
    };
  };

  const notifyStalledJobs = (): void => {
    const threshold = stallTimeoutMs();
    for (const job of store.listJobs()) {
      if (job.status !== "running") {
        stallNotified.delete(job.id);
        continue;
      }
      const runtime = computeRuntime(job);
      if (runtime.in_flight || runtime.idle_ms == null || runtime.idle_ms < threshold) continue;
      if (stallNotified.has(job.id)) continue;
      stallNotified.add(job.id);
      hook("on_job_stalled", {
        event: "job_stalled",
        job_id: job.id,
        goal: job.goal,
        idle_ms: runtime.idle_ms,
      });
    }
  };

  const handle = async (req: Request, push: PushFn): Promise<Response> => {
    switch (req.method) {
      case "ping":
        return ok(req.id, { pong: true, version: VERSION });

      case "job.create": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { goal, cwd, id: customId } = req.params;
        if (!goal?.trim()) return err(req.id, "bad_request", "job goal must not be empty");
        if (customId !== undefined) {
          if (!customId.trim()) return err(req.id, "bad_request", "job id must not be empty");
          if (!/^[a-zA-Z0-9_-]+$/.test(customId))
            return err(
              req.id,
              "bad_request",
              "job id must contain only alphanumeric characters, hyphens, or underscores",
            );
          if (store.getJob(customId))
            return err(req.id, "bad_request", `job id '${customId}' already exists`);
        }
        const normalizedCwd = normalizeCwd(cwd);
        const invalidCwd = cwdError(normalizedCwd);
        if (invalidCwd) return err(req.id, "bad_request", invalidCwd);
        const job = store.createJob(goal.trim(), normalizedCwd, customId);

        // Provision git worktree for isolation. Fails the job immediately if the
        // source is a real git repo but worktree creation fails (accepted decision).
        try {
          const worktree = await provisionWorktree(normalizedCwd, job.id, job.branch!);
          if (worktree) {
            store.setJobWorktree(job.id, worktree);
            job.worktree = worktree;
          }
        } catch (e) {
          store.setJobStatus(job.id, "failed");
          store.createMessage({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: `Worktree provisioning failed: ${(e as Error).message}`,
          });
          return err(req.id, "provisioning_failed", (e as Error).message);
        }

        debug("job created", { job: job.id, goal: job.goal, worktree: job.worktree });
        if (team) jobTeamSnapshots.set(job.id, team);
        createMsg({
          job_id: job.id,
          from_role: "user",
          to_role: SUPERVISOR,
          kind: "message",
          body: job.goal,
        });
        enqueueDispatch(job, SUPERVISOR, job.goal);
        return ok(req.id, { job });
      }

      case "job.list":
        return ok(req.id, { jobs: store.listJobs() });

      case "job.get": {
        const job = store.getJob(req.params.id);
        return job
          ? ok(req.id, { job, runtime: computeRuntime(job) })
          : err(req.id, "not_found", `no job ${req.params.id}`);
      }

      case "team.get": {
        if (!team) return err(req.id, "no_team", "no team.yaml configured");
        const roles: RoleSummary[] = Object.entries(team.roles).map(([name, r]) => ({
          name,
          adapter: r.adapter,
          model: r.model,
        }));
        return ok(req.id, { roles });
      }

      case "msg.list": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        const messages = store.listMessages(req.params.job_id);
        if (req.params.mark_read) {
          for (const msg of messages) store.markMessageRead(msg.id);
        }
        return ok(req.id, { messages });
      }

      case "msg.send": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { from, job_id, to, body, refs } = req.params;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (!body?.trim()) return err(req.id, "bad_request", "message body must not be empty");
        const routingTeam = jobTeamSnapshots.get(job_id) ?? team!;
        if (!isAllowed(routingTeam, from, to))
          return err(req.id, "forbidden", `${from} may not send to ${to}`);
        const msg = createMsg({
          job_id,
          from_role: from,
          to_role: to,
          kind: "message",
          body,
          refs,
        });
        if (to !== "user") {
          enqueueDispatch(job, to, body);
        } else if (from === SUPERVISOR) {
          hook("on_supervisor_message", { event: "supervisor_message", job_id, body });
        }
        return ok(req.id, { queued: true, message: msg });
      }

      case "msg.escalate": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { from, job_id, reason } = req.params;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (!reason?.trim())
          return err(req.id, "bad_request", "escalation reason must not be empty");
        const escalationTeam = jobTeamSnapshots.get(job_id) ?? team!;
        if (!escalationTeam.roles[from]) return err(req.id, "forbidden", `unknown role ${from}`);
        const msg = createMsg({
          job_id,
          from_role: from,
          to_role: SUPERVISOR,
          kind: "escalation",
          body: reason,
        });
        enqueueDispatch(job, SUPERVISOR, `Escalation from ${from}:\n\n${reason}`);
        return ok(req.id, { queued: true, message: msg });
      }

      case "msg.watch": {
        const { job_id, mark_read } = req.params;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (!msgWatchers.has(job_id)) msgWatchers.set(job_id, new Set());
        const watcher = (frame: PushFrame): boolean => {
          if (mark_read && frame.event === "msg.new") store.markMessageRead(frame.data.id);
          return push(frame);
        };
        msgWatchers.get(job_id)!.add(watcher);
        return ok(req.id, { watching: true });
      }

      case "job.complete": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "done");
        createMsg({
          job_id: req.params.job_id,
          from_role: SUPERVISOR,
          to_role: "user",
          kind: "completion",
          body: req.params.result,
        });
        hook("on_job_done", {
          event: "job_done",
          job_id: job.id,
          goal: job.goal,
          result: req.params.result,
        });
        return ok(req.id, { done: true });
      }

      case "job.fail": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "failed");
        createMsg({
          job_id: req.params.job_id,
          from_role: SUPERVISOR,
          to_role: "user",
          kind: "failure",
          body: req.params.reason,
        });
        hook("on_job_failed", {
          event: "job_failed",
          job_id: job.id,
          goal: job.goal,
          reason: req.params.reason,
        });
        return ok(req.id, { failed: true });
      }

      case "job.tell": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { job_id, body } = req.params;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (job.status !== "running")
          return err(req.id, "bad_request", `job ${job_id} is not running (status: ${job.status})`);
        if (!body?.trim()) return err(req.id, "bad_request", "message body must not be empty");
        const msg = createMsg({
          job_id,
          from_role: "user",
          to_role: SUPERVISOR,
          kind: "message",
          body,
        });
        enqueueDispatch(job, SUPERVISOR, body);
        return ok(req.id, { queued: true, message: msg });
      }

      case "job.stop": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        if (job.status !== "running")
          return err(
            req.id,
            "bad_request",
            `job ${req.params.job_id} is not running (status: ${job.status})`,
          );
        debug("job stop", { job: job.id });
        store.setJobStatus(req.params.job_id, "failed");
        createMsg({
          job_id: req.params.job_id,
          from_role: "user",
          to_role: "user",
          kind: "failure",
          body: "Job stopped by user.",
        });
        hook("on_job_failed", {
          event: "job_failed",
          job_id: job.id,
          goal: job.goal,
          reason: "Job stopped by user.",
        });
        return ok(req.id, { stopped: true });
      }

      case "job.kill": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        if (job.status !== "running")
          return err(
            req.id,
            "bad_request",
            `job ${req.params.job_id} is not running (status: ${job.status})`,
          );
        debug("job kill", { job: job.id });
        store.setJobStatus(req.params.job_id, "interrupted");
        createMsg({
          job_id: req.params.job_id,
          from_role: "user",
          to_role: "user",
          kind: "failure",
          body: "Job killed by user.",
        });
        hook("on_job_failed", {
          event: "job_failed",
          job_id: job.id,
          goal: job.goal,
          reason: "Job killed by user.",
        });
        // Abort all in-flight dispatches for this job.
        const controllers = jobKillControllers.get(req.params.job_id);
        if (controllers) {
          for (const ac of controllers) ac.abort();
        }
        return ok(req.id, { killed: true });
      }

      case "daemon.stop": {
        debug("daemon.stop requested");
        void Promise.resolve().then(() => doClose());
        return ok(req.id, { stopping: true });
      }

      case "reload": {
        try {
          const newTeam = loadTeam(teamFile);
          team = newTeam;
          if (!options.turnRunner) runner = defaultTurnRunner();
          emitTeamModelWarnings(newTeam, "reload");
          const roles: RoleSummary[] = Object.entries(newTeam.roles).map(([name, r]) => ({
            name,
            adapter: r.adapter,
            model: r.model,
          }));
          return ok(req.id, { roles });
        } catch (e) {
          return err(req.id, "reload_failed", (e as Error).message);
        }
      }

      default:
        return err((req as Request).id, "unknown_method", `unknown method`);
    }
  };

  const server = await serve(endpoint, handle);
  stallWatchdog = setInterval(() => {
    notifyStalledJobs();
  }, stallIntervalMs);

  const close = async (): Promise<void> => {
    debug("closing");
    if (stallWatchdog) {
      clearInterval(stallWatchdog);
      stallWatchdog = null;
    }
    await Promise.allSettled(pendingDispatches);
    await server.close();
    if (ownsStore) store.close();
  };
  doClose = close;

  return { endpoint, close };
}
