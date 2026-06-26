/**
 * agvsrd — the central daemon (D6). Owns the store, IPC server, message router,
 * and the per-job agent session registry used by the resume-invoke runtime.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "../ipc/transport.ts";
import { Store } from "./store.ts";
import { allowedTargets, loadTeam, SUPERVISOR, type TeamConfig } from "../config/team.ts";
import { ensureConfigDir, ipcEndpoint, storePath } from "../paths.ts";
import { VERSION } from "../version.ts";
import { composeCharter, driverFor, runTurn, type TurnResult } from "../adapters/index.ts";
import { fireHook, type HookEvent } from "../hooks.ts";
import type { Job, Request, Response, RoleSummary } from "../protocol.ts";

function resolveTeam(): TeamConfig | null {
  const candidate = process.env.AGVSR_TEAM ?? join(process.cwd(), "team.yaml");
  if (!existsSync(candidate)) return null;
  return loadTeam(candidate);
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
  job: Job;
  message: string;
  sessionId: string | null;
  systemPrompt: string;
  env: Record<string, string>;
}

export type TurnRunner = (dispatch: TurnDispatch) => Promise<TurnResult>;

export interface StartDaemonOptions {
  store?: Store;
  storeFile?: string;
  team?: TeamConfig | null;
  endpoint?: string;
  turnRunner?: TurnRunner;
  /** D17 fail-safe: mark stale running jobs interrupted when a daemon starts. */
  interruptRunningJobsOnStart?: boolean;
  /** Override hook runner for testing (default: fireHook). */
  hookRunner?: (cmd: string, event: HookEvent) => void;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_WORKER_FAILURES = 3;

function turnTimeoutMs(): number {
  const raw = process.env.AGVSR_TURN_TIMEOUT_MS;
  if (!raw) return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TURN_TIMEOUT_MS;
}

function maxWorkerFailures(): number {
  const raw = process.env.AGVSR_MAX_WORKER_FAILURES;
  if (!raw) return DEFAULT_MAX_WORKER_FAILURES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_WORKER_FAILURES;
}

function defaultTurnRunner(team: TeamConfig): TurnRunner {
  return async ({ role, job, message, sessionId, systemPrompt, env }) => {
    const roleConfig = team.roles[role];
    if (!roleConfig) throw new Error(`no role ${role}`);
    const driver = driverFor(roleConfig.adapter);
    return runTurn(
      driver,
      {
        role,
        adapter: roleConfig.adapter,
        model: roleConfig.model,
        cwd: job.cwd,
        systemPrompt,
        env,
      },
      sessionId,
      message,
      { timeoutMs: turnTimeoutMs() },
    );
  };
}

function isAllowed(team: TeamConfig, from: string, to: string): boolean {
  if (from === "user") return to === SUPERVISOR;
  if (!team.roles[from]) return false;
  return allowedTargets(team, from).includes(to);
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<Daemon> {
  ensureConfigDir();
  const store = options.store ?? new Store(options.storeFile ?? storePath());
  const ownsStore = !options.store;
  const team = options.team === undefined ? resolveTeam() : options.team;
  const endpoint = options.endpoint ?? ipcEndpoint();
  const runner = team ? (options.turnRunner ?? defaultTurnRunner(team)) : null;
  const hookRun = options.hookRunner ?? fireHook;
  const hook = (hookName: keyof NonNullable<TeamConfig["hooks"]>, event: HookEvent): void => {
    const cmd = team?.hooks?.[hookName];
    if (cmd) hookRun(cmd, event);
  };
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
  const inflight = new Map<string, Promise<void>>();
  const pendingDispatches = new Set<Promise<void>>();

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

  const dispatchRole = async (job: Job, role: string, message: string): Promise<void> => {
    if (!team || !runner) throw new Error("no team.yaml configured");
    const roleConfig = team.roles[role];
    if (!roleConfig) throw new Error(`no role ${role}`);

    const sessionId = sessionFor(job.id, role);
    const systemPrompt = sessionId
      ? ""
      : composeCharter(
          team,
          role,
          { jobId: job.id, cwd: job.cwd },
          { baseDir: dirname(process.env.AGVSR_TEAM ?? process.cwd()) },
        );
    const result = await runner({
      role,
      job,
      message,
      sessionId,
      systemPrompt,
      env: {
        AGVSR_SOCK: endpoint,
        AGVSR_ROLE: role,
        AGVSR_JOB_ID: job.id,
        AGVSR_ALLOWED: allowedTargets(team, role).join(","),
      },
    });

    setSession(job.id, role, result.outcome.sessionId ?? sessionId);
    if (result.outcome.exitCode !== 0) {
      if (role === SUPERVISOR || result.outcome.timedOut) {
        const reason = `${role} turn failed${result.outcome.timedOut ? " by timeout" : ""}.`;
        store.setJobStatus(job.id, "failed");
        store.createMessage({
          job_id: job.id,
          from_role: "daemon",
          to_role: "user",
          kind: "failure",
          body: reason,
        });
        hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
      } else {
        const failures = incrementFailure(job.id, role);
        const threshold = maxWorkerFailures();
        if (failures >= threshold) {
          const reason = `${role} failed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).`;
          store.setJobStatus(job.id, "failed");
          store.createMessage({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: reason,
          });
          hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
        } else {
          const body = `${role} turn failed with exit code ${result.outcome.exitCode} (failure ${failures}/${threshold}). Supervisor must decide whether to retry, reassign, or fail the job.`;
          store.createMessage({
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
    }
  };

  const enqueueDispatch = (job: Job, role: string, message: string): void => {
    const key = `${job.id}:${role}`;
    const previous = inflight.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => dispatchRole(job, role, message))
      .catch((e) => {
        const message = (e as Error).message;
        if (role === SUPERVISOR) {
          store.setJobStatus(job.id, "failed");
          store.createMessage({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: message,
          });
          hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason: message });
        } else {
          const failures = incrementFailure(job.id, role);
          const threshold = maxWorkerFailures();
          if (failures >= threshold) {
            const reason = `${role} crashed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).`;
            store.setJobStatus(job.id, "failed");
            store.createMessage({
              job_id: job.id,
              from_role: "daemon",
              to_role: "user",
              kind: "failure",
              body: reason,
            });
            hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
          } else {
            const body = `${role} turn crashed: ${message} (crash ${failures}/${threshold}). Supervisor must decide whether to retry, reassign, or fail the job.`;
            store.createMessage({
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

  const requireTeam = (id: string): Response | null =>
    team ? null : err(id, "no_team", "no team.yaml configured");

  const handle = (req: Request): Response => {
    switch (req.method) {
      case "ping":
        return ok(req.id, { pong: true, version: VERSION });

      case "job.create": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { goal, cwd } = req.params;
        if (!goal?.trim()) return err(req.id, "bad_request", "job goal must not be empty");
        const job = store.createJob(goal.trim(), cwd);
        store.createMessage({
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
        return job ? ok(req.id, { job }) : err(req.id, "not_found", `no job ${req.params.id}`);
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
        if (!isAllowed(team!, from, to))
          return err(req.id, "forbidden", `${from} may not send to ${to}`);
        const msg = store.createMessage({
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
        if (!team!.roles[from]) return err(req.id, "forbidden", `unknown role ${from}`);
        const msg = store.createMessage({
          job_id,
          from_role: from,
          to_role: SUPERVISOR,
          kind: "escalation",
          body: reason,
        });
        enqueueDispatch(job, SUPERVISOR, `Escalation from ${from}:\n\n${reason}`);
        return ok(req.id, { queued: true, message: msg });
      }

      case "job.complete": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "done");
        store.createMessage({
          job_id: req.params.job_id,
          from_role: SUPERVISOR,
          to_role: "user",
          kind: "completion",
          body: req.params.result,
        });
        hook("on_job_done", { event: "job_done", job_id: job.id, goal: job.goal, result: req.params.result });
        return ok(req.id, { done: true });
      }

      case "job.fail": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        store.setJobStatus(req.params.job_id, "failed");
        store.createMessage({
          job_id: req.params.job_id,
          from_role: SUPERVISOR,
          to_role: "user",
          kind: "failure",
          body: req.params.reason,
        });
        hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason: req.params.reason });
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
        const msg = store.createMessage({
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
          return err(req.id, "bad_request", `job ${req.params.job_id} is not running (status: ${job.status})`);
        store.setJobStatus(req.params.job_id, "failed");
        store.createMessage({
          job_id: req.params.job_id,
          from_role: "user",
          to_role: "user",
          kind: "failure",
          body: "Job stopped by user.",
        });
        hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason: "Job stopped by user." });
        return ok(req.id, { stopped: true });
      }

      default:
        return err((req as Request).id, "unknown_method", `unknown method`);
    }
  };

  const server = await serve(endpoint, handle);

  const close = async (): Promise<void> => {
    await Promise.allSettled([...pendingDispatches]);
    await server.close();
    if (ownsStore) store.close();
  };

  return { endpoint, close };
}

// Run directly: `bun run src/daemon/daemon.ts`
if (import.meta.main) {
  const daemon = await startDaemon();
  console.log(`agvsrd ${VERSION} listening on ${daemon.endpoint}`);
  const shutdown = async () => {
    console.log("\nagvsrd shutting down");
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
