/**
 * agvsrd — the central daemon (D6). Owns the store, IPC server, message router,
 * and the per-job agent session registry used by the resume-invoke runtime.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { serve, type PushFn } from "../ipc/transport.ts";
import { provisionWorktree } from "../git/worktree.ts";
import { checkJobCommitGate, recoverableDirtyWorktreeNote } from "../git/commit-gate.ts";
import { mergeInstanceBranch } from "../git/merge.ts";
import { assessWorktree, git } from "../git/cleanup.ts";
import {
  copyDeclaredEnvFiles,
  envFileVariables,
  envParityEnabled,
  envParityErrorMessage,
  repoRootOf,
  unresolvedEnvFiles,
} from "../git/env-parity.ts";
import { refsGateEnabled, refsGateMessage, uncommittedRefs } from "../git/refs-gate.ts";
import {
  decisionLedgerEnabled,
  decisionsFromRefs,
  driftMessage,
  frozenNotice,
  mentionedDecisions,
  outOfScopeDrift,
} from "../git/decisions.ts";
import { checkpointRef, checkpointsEnabled, createCheckpoint } from "../git/checkpoint.ts";
import { checkVerifyGate, verifyGateEnabled, type VerifyOutcome } from "../git/verify.ts";
import { Store } from "./store.ts";
import {
  allowedTargets,
  findTeamFile,
  loadTeam,
  resolveTeamFile,
  SUPERVISOR,
  type TeamConfig,
} from "../config/team.ts";
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
import { fireHook, noopPushNotifier, type HookEvent, type PushNotifier } from "../hooks.ts";
import { createHerdrClient, type HerdrAgent, type HerdrClient } from "../herdr/client.ts";
import type {
  Job,
  JobRuntime,
  JobStatus,
  Message,
  PushFrame,
  Request,
  Response,
  RoleSummary,
  UsageBucket,
  UsageRate,
  UsageTotals,
} from "../protocol.ts";
import type { Adapter } from "../config/team.ts";

export type ReviewerKind = "claude" | "codex";

export type ReviewResolution =
  | { ok: true; agent: HerdrAgent }
  | { ok: false; code: string; message: string };

function adapterReviewerKind(adapter: Adapter): ReviewerKind | null {
  if (adapter === "claude-code") return "claude";
  if (adapter === "codex") return "codex";
  return null;
}

/** Pure, order-independent reviewer selection. Never falls back across workspaces. */
export function resolveReviewAgent(input: {
  agents: HerdrAgent[];
  workspaceId: string;
  reviewerKind: ReviewerKind;
  requesterAdapter: Adapter;
  reviewerPaneId?: string;
}): ReviewResolution {
  const requesterKind = adapterReviewerKind(input.requesterAdapter);
  if (requesterKind === input.reviewerKind) {
    return {
      ok: false,
      code: "reviewer_same_kind",
      message: `reviewer kind ${input.reviewerKind} must differ from the requesting adapter`,
    };
  }

  const candidates = input.agents.filter(
    (agent) =>
      agent.workspace_id === input.workspaceId && agent.agent.toLowerCase() === input.reviewerKind,
  );

  if (input.reviewerPaneId) {
    const match = candidates.find((agent) => agent.pane_id === input.reviewerPaneId);
    if (match) return { ok: true, agent: match };
    return {
      ok: false,
      code: "reviewer_mismatch",
      message:
        `reviewer pane ${input.reviewerPaneId} is not a ${input.reviewerKind} agent ` +
        `in workspace ${input.workspaceId}`,
    };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: "reviewer_not_found",
      message: `no ${input.reviewerKind} reviewer found in workspace ${input.workspaceId}`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: "reviewer_ambiguous",
      message:
        `multiple ${input.reviewerKind} reviewers found in workspace ${input.workspaceId}: ` +
        candidates.map((agent) => agent.pane_id).join(", "),
    };
  }
  return { ok: true, agent: candidates[0]! };
}

function resolveTeam(file?: string): TeamConfig | null {
  const candidate = resolveTeamFile(file);
  if (!existsSync(candidate)) return null;
  return loadTeam(candidate);
}

/**
 * Per-job team resolution (D-multiproject): one daemon serves every project
 * on the machine, but each job's target repo may carry its own `team.yaml`
 * (written by `agvsr init`). If it does, that project's roles/adapters/models
 * are used for this job — captured once into `jobTeamSnapshots` at creation,
 * the same freeze-on-create mechanism D17 already uses so `agvsr reload`
 * doesn't change an in-flight job's config. Falls back to null (caller uses
 * the daemon's global default team) when the job's cwd has no team.yaml of
 * its own. Does NOT consult `$AGVSR_TEAM` — that variable is a daemon-startup
 * default, not something that can vary per concurrently-running job.
 * Throws TeamConfigError if the job's own team.yaml exists but is invalid,
 * so a typo in one project's config never silently falls back to running
 * that job under a different project's team.
 */
function resolveJobTeam(jobCwd: string): TeamConfig | null {
  const candidate = findTeamFile(jobCwd);
  return candidate === null ? null : loadTeam(candidate);
}

const ok = (id: string, result: unknown): Response => ({ id, type: "response", ok: true, result });
const err = (id: string, code: string, message: string): Response => ({
  id,
  type: "response",
  ok: false,
  error: { code, message },
});

const HOUR_MS = 3_600_000;
const MAX_USAGE_WINDOW_MS = 30 * 24 * HOUR_MS;

function usageWindowError(windowMs: unknown, bucketMs: unknown): string | null {
  if (typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0) {
    return "window_ms must be a finite positive number";
  }
  if (windowMs > MAX_USAGE_WINDOW_MS) return "window_ms must not exceed 30d";
  if (bucketMs === undefined) return null;
  if (bucketMs !== HOUR_MS) return "bucket_ms currently supports only 1h";
  if (bucketMs > windowMs) return "bucket_ms must not exceed window_ms";
  return null;
}

function zeroUsageTotals(): UsageTotals {
  return {
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    cost_partial: false,
  };
}

function usageRate(totals: UsageTotals, windowMs: number): UsageRate {
  const hours = windowMs / HOUR_MS;
  return {
    turns: totals.turns / hours,
    input_tokens: totals.input_tokens / hours,
    output_tokens: totals.output_tokens / hours,
    cache_read_tokens: totals.cache_read_tokens / hours,
    cache_write_tokens: totals.cache_write_tokens / hours,
    reasoning_tokens: totals.reasoning_tokens / hours,
    cost_usd: totals.cost_usd / hours,
    cost_partial: totals.cost_partial,
  };
}

function usageBuckets(
  sparse: Array<{ hour_start: string; totals: UsageTotals }>,
  startMs: number,
  endMs: number,
): UsageBucket[] {
  const byHour = new Map(sparse.map((row) => [Date.parse(row.hour_start), row.totals]));
  const buckets: UsageBucket[] = [];
  for (let hour = Math.floor(startMs / HOUR_MS) * HOUR_MS; hour < endMs; hour += HOUR_MS) {
    const bucketStart = Math.max(hour, startMs);
    const bucketEnd = Math.min(hour + HOUR_MS, endMs);
    buckets.push({
      start_at: new Date(bucketStart).toISOString(),
      end_at: new Date(bucketEnd).toISOString(),
      partial: bucketStart !== hour || bucketEnd !== hour + HOUR_MS,
      totals: byHour.get(hour) ?? zeroUsageTotals(),
    });
  }
  return buckets;
}

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
  /** From the role's `network_access` in team.yaml (default false). */
  networkAccess?: boolean;
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
  /** Called on each real stdout chunk; lets the daemon track real progress time (Tier 2). */
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
  /** Push notifier injected at startup (default: no-op). */
  pushNotifier?: PushNotifier;
  /** Override resolved PATH (default: query $SHELL login profile). */
  userPath?: string;
  /** herdr CLI wrapper injected for testing (default: createHerdrClient()). */
  herdrClient?: HerdrClient;
  /** Shutdown drain budget in ms (default: 10s, or AGVSR_SHUTDOWN_DRAIN_MS). */
  shutdownDrainMs?: number;
  /** Exit the process once an IPC `daemon.stop` has finished closing. Only the
   * long-running `agvsr daemon` process wants this; embedders and tests do not. */
  exitOnStop?: boolean;
  /** Process exit, injectable for testing (default: process.exit). */
  exit?: (code: number) => void;
}

const DEFAULT_MAX_WORKER_FAILURES = 3;

/** Default idle (no-progress) timeout — mirrors the old 10 minute timeout feel. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Default hard (wall-clock) timeout — safety cap for long but progressing turns. */
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Consecutive supervisor turns that route nothing before the job is failed (D36).
 * Earlier turns get an explanatory nudge instead — and a supervisor waiting on an
 * unanswered question to the human is never counted at all.
 */
const MAX_SUPERVISOR_IDLE_TURNS = 3;

/** How long a shutdown waits for in-flight turns before aborting them. */
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
/** Extra window for aborted turns to unwind after their subprocess is killed. */
const ABORT_GRACE_MS = 2_000;

/**
 * Wait for the currently pending dispatches, capped at `timeoutMs`.
 * Returns false if the budget ran out first. The timer is always cleared so a
 * losing race never keeps the event loop (and the process) alive on its own.
 */
async function drainPending(pending: Set<Promise<void>>, timeoutMs: number): Promise<boolean> {
  if (pending.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    // allSettled iterates the Set once, now — dispatches enqueued after this
    // point are deliberately not part of this drain.
    return await Promise.race([Promise.allSettled(pending).then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

const USAGE_LIMIT_PATTERNS = [
  /hit your (?:monthly|weekly|daily|5[- ]?hour) (?:spend |usage )?limit/i,
  /(?:monthly|weekly|daily|5[- ]?hour) (?:spend |usage )?limit (?:reached|exceeded)/i,
  /(?:rate|usage|spend) limit (?:reached|exceeded)/i,
  /too many requests/i,
  /quota (?:has been )?(?:reached|exceeded)/i,
];

export function isUsageLimitError(text: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

function usageLimitCause(text: string): string | null {
  const index = USAGE_LIMIT_PATTERNS.findIndex((pattern) => pattern.test(text));
  return index < 0 ? null : `usage-limit-pattern-${index}`;
}

function usageLimitEscalation(
  role: string,
  adapter: Adapter,
  model: string,
  diagnostics: string,
  occurrence: number,
  team: TeamConfig,
  limitedAdapters: Set<Adapter>,
): string {
  const rolesByAdapter = new Map<Adapter, string[]>();
  for (const [name, config] of Object.entries(team.roles)) {
    const roles = rolesByAdapter.get(config.adapter) ?? [];
    roles.push(name);
    rolesByAdapter.set(config.adapter, roles);
  }
  const describe = (limited: boolean): string => {
    const rows = [...rolesByAdapter]
      .filter(([candidate]) => limitedAdapters.has(candidate) === limited)
      .map(([candidate, roles]) => `${candidate}: ${roles.join(", ")}`);
    return rows.length > 0 ? rows.join("; ") : "(none)";
  };
  return [
    `${role} cannot continue because ${adapter} reported a usage/rate limit (${occurrence}${
      occurrence === 1 ? "st" : occurrence === 2 ? "nd" : occurrence === 3 ? "rd" : "th"
    } consecutive occurrence).`,
    `The job remains running, but this worker will not be retried automatically. ` +
      `Resolve or wait for the provider limit, then resume with agvsr tell.`,
    `Available adapters/roles: ${describe(false)}`,
    `Limited adapters/roles: ${describe(true)}`,
    `role=${role} adapter=${adapter} model=${model}`,
    `diagnostics:\n${tailText(diagnostics, 2048)}`,
  ].join("\n\n");
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

const STDERR_DIAG_CAP = 2048;

function turnFailureDiagnostics(
  adapter: Adapter,
  model: string,
  exitCode: number,
  stderrTail: string | undefined,
  stdoutTail?: string,
): string {
  const stderr = tailText(stderrTail ?? "", STDERR_DIAG_CAP);
  const stdout = stderr ? "" : tailText(stdoutTail ?? "", STDERR_DIAG_CAP);
  return [
    `exitCode=${exitCode} adapter=${adapter} model=${model}`,
    stderr
      ? `stderrTail:\n${stderr}`
      : stdout
        ? `stderrTail: (empty)\n\nstdoutTail:\n${stdout}`
        : "stderrTail: (empty)\n\nstdoutTail: (empty)",
  ].join("\n\n");
}

/**
 * Place `copy`-declared environment files into a newly provisioned worktree (D43).
 * Best effort, like dependency seeding: a file that cannot be placed leaves the
 * job exactly as it would have been before this existed.
 */
function placeDeclaredEnvFiles(cwd: string, worktree: string, team: TeamConfig): void {
  if (!team.worktree?.env_files) return;
  const root = repoRootOf(cwd);
  if (!root) return;
  try {
    copyDeclaredEnvFiles(root, worktree, team);
  } catch (e) {
    console.error(`[agvsr] env file placement skipped: ${(e as Error).message}`);
  }
}

function appendRecoverableDirtyWorktreeNote(
  job: Job,
  reason: string,
  extraWorktrees: Array<{ worktree: string; branch: string }> = [],
): string {
  const note = recoverableDirtyWorktreeNote(job, extraWorktrees);
  return note ? `${reason}\n${note}` : reason;
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

// Design-approval gate (D-gate): once a design has been handed to the supervisor, block the
// supervisor → implementation handoff until the human approves. Structural backstop for the
// charter rule; applies to all jobs. Disable with AGVSR_DESIGN_GATE in {0,off,false,no}.
// Approval/rejection wording is matched in English and Japanese: humans answer the gate in
// whatever language they run the job in, and an unrecognised "承認します" used to read as
// "not approved" and re-open the gate on a design the human had already signed off.
const APPROVAL_RE =
  /\b(approve|approved|approval granted|go ahead|proceed|ship it|lgtm)\b|承認(?!しな|しませ|できま|を?(取り消|撤回|保留))|了承|許可します|進めてください|着手してください|問題ありません|異存はありません/i;
const REJECTION_RE =
  /\b(not approved|do not proceed|don'?t proceed|hold|stop|reject|rejected)\b|承認しな|承認しませ|承認できま|承認を?(取り消|撤回|保留)|却下|中止して|やめてください|一旦(停止|保留)|待ってください/i;

function designGateEnabled(): boolean {
  const raw = process.env.AGVSR_DESIGN_GATE;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

/** Reclaim a finished job's spent worktrees (D42). Disable with AGVSR_AUTO_RECLAIM=0. */
function autoReclaimEnabled(): boolean {
  const raw = process.env.AGVSR_AUTO_RECLAIM;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function isImplementationRole(role: string): boolean {
  return role === "implementation" || role.startsWith("implementation");
}

/** Latest design → supervisor handoff for the job, or null if design was skipped. */
function lastDesignHandoff(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.from_role === "design" && m.to_role === SUPERVISOR) return m;
  }
  return null;
}

function hasOutstandingIdenticalDelegation(
  messages: Message[],
  from: string,
  to: string,
  body: string,
): boolean {
  const normalized = body.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.from_role === to && message.to_role === from) return false;
    if (
      message.kind === "message" &&
      message.from_role === from &&
      message.to_role === to &&
      message.body.trim() === normalized
    ) {
      return true;
    }
  }
  return false;
}

// Delegation guard (D44). A supervisor delegated a design and, 30 seconds later,
// told the human that design was unresponsive and needed restarting — while
// design had not yet run a single turn. Nothing was wrong except that nobody had
// waited. The charter cannot fix this: "wait longer" is a judgement call, and the
// supervisor was making it from a position of not knowing whether the delegate
// had started. These guards remove the failure by making the two actions that
// waste a human round-trip unavailable while the delegate is still starting up.
const DEFAULT_MIN_DELEGATION_WAIT_MS = 5 * 60 * 1000;

function delegationGuardEnabled(): boolean {
  const raw = process.env.AGVSR_DELEGATION_GUARD;
  return !raw || !/^(0|off|false|no)$/i.test(raw.trim());
}

function minDelegationWaitMs(roleConfig?: import("../config/team.ts").RoleConfig): number {
  // `!== undefined`, not truthiness: 0 is a valid configured value meaning
  // "never hold an escalation", and treating it as unset would silently
  // reinstate the five-minute default the operator just turned off.
  if (roleConfig?.min_delegation_wait_ms !== undefined) return roleConfig.min_delegation_wait_ms;
  const raw = process.env.AGVSR_MIN_DELEGATION_WAIT_MS;
  if (!raw) return DEFAULT_MIN_DELEGATION_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_MIN_DELEGATION_WAIT_MS;
}

/**
 * The supervisor's latest delegation to `to` that `to` has not answered, or null
 * when the last exchange with that role was a reply.
 */
function outstandingDelegation(messages: Message[], to: string): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.from_role === to && m.to_role === SUPERVISOR) return null;
    if (m.from_role === SUPERVISOR && m.to_role === to && m.kind === "message") return m;
  }
  return null;
}

/** Every unanswered supervisor delegation in the job, by role. */
function outstandingDelegations(
  messages: Message[],
  team: TeamConfig,
): Array<{ role: string; message: Message }> {
  const out: Array<{ role: string; message: Message }> = [];
  for (const role of Object.keys(team.roles)) {
    if (role === SUPERVISOR) continue;
    const message = outstandingDelegation(messages, role);
    if (message) out.push({ role, message });
  }
  return out;
}

function describeAge(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * Read a human (user → supervisor) message as a verdict on the design: "approve",
 * "reject", or null for an ordinary message that says nothing about approval. Only a
 * verdict moves the gate — a plain progress report or a piece of environment info leaves
 * an existing approval standing.
 */
function approvalVerdict(body: string): "approve" | "reject" | null {
  if (REJECTION_RE.test(body)) return "reject";
  if (APPROVAL_RE.test(body)) return "approve";
  return null;
}

function refsOf(message: Message): string[] {
  if (!message.refs) return [];
  try {
    const parsed = JSON.parse(message.refs);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The design handoff still awaiting human approval, or null if implementation may proceed.
 *
 * Approval is durable job state (`design_approved_at`), so it survives any number of
 * unrelated human messages. It is revoked only by an explicit rejection or by a design
 * handoff that widens the design surface: a handoff whose refs all fall inside the
 * approved set is design reporting back on the *same* design (a re-commit, a "the file is
 * in place now" confirmation) and must not re-gate work the human already signed off. A
 * handoff carrying no refs at all is unattributable, so it re-gates.
 */
function pendingDesignApproval(job: Job, messages: Message[]): Message | null {
  const latest = lastDesignHandoff(messages);
  if (!latest) return null; // design was skipped for this job — gate does not apply
  if (!job.design_approved_at) return latest;

  const approvedRefs = new Set<string>(
    job.design_approved_refs ? (JSON.parse(job.design_approved_refs) as string[]) : [],
  );
  for (const m of messages) {
    if (m.created_at <= job.design_approved_at) continue;
    if (m.from_role !== "design" || m.to_role !== SUPERVISOR) continue;
    const refs = refsOf(m);
    if (refs.length === 0 || refs.some((r) => !approvedRefs.has(r))) return m;
  }
  return null;
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
    networkAccess,
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
        networkAccess,
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
  const home = process.env.HOME ?? homedir();
  const expanded =
    input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
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
  const teamFile = resolveTeamFile(options.teamFile);
  let team = options.team === undefined ? resolveTeam(options.teamFile) : options.team;
  const endpoint = options.endpoint ?? ipcEndpoint();
  let runner: TurnRunner | null = options.turnRunner ?? (team ? defaultTurnRunner() : null);
  const hookRun = options.hookRunner ?? fireHook;
  const pushNotify = options.pushNotifier ?? noopPushNotifier;
  const herdrClient = options.herdrClient ?? createHerdrClient();
  const drainMs =
    options.shutdownDrainMs ??
    parseTimeoutEnv("AGVSR_SHUTDOWN_DRAIN_MS") ??
    DEFAULT_SHUTDOWN_DRAIN_MS;
  const exitProcess = options.exit ?? ((code: number) => process.exit(code));
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

  // Best-effort delivery to the herdr pane that submitted the job — the
  // "front-desk" agent (D31). No-op in standalone mode (caller_pane_id is
  // null) or if herdr is unreachable; the CLI/Web/hook paths above already
  // carry the same event independently.
  const herdrEscalate = (jobId: string, text: string): void => {
    const job = store.getJob(jobId);
    if (!job?.caller_pane_id) return;
    void herdrClient.promptAgent(job.caller_pane_id, text, job.herdr_session);
  };

  // Always reads current `team` so hooks update immediately after reload.
  const hook = (hookName: keyof NonNullable<TeamConfig["hooks"]>, event: HookEvent): void => {
    const cmd = team?.hooks?.[hookName];
    if (cmd) hookRun(cmd, event);

    const jobId = typeof event.job_id === "string" ? event.job_id : null;
    if (!jobId) return;
    if (hookName === "on_job_done") {
      pushNotify({ job_id: jobId, status: "done" });
      herdrEscalate(jobId, `[agvsr] job ${jobId} done: ${String(event.goal ?? "")}`);
    } else if (hookName === "on_job_stalled") {
      pushNotify({ job_id: jobId, status: "stalled" });
      herdrEscalate(jobId, `[agvsr] job ${jobId} stalled (no progress) — agvsr status ${jobId}`);
    } else if (hookName === "on_supervisor_message") {
      pushNotify({ job_id: jobId, status: "attention" });
      herdrEscalate(
        jobId,
        `[agvsr] job ${jobId} needs your input:\n\n${String(event.body ?? "")}\n\nReply: agvsr tell ${jobId} "..."`,
      );
    } else if (hookName === "on_job_failed") {
      const job = store.getJob(jobId);
      const status = job?.status ?? "failed";
      pushNotify({ job_id: jobId, status });
      herdrEscalate(jobId, `[agvsr] job ${jobId} failed: ${String(event.reason ?? "")}`);
    }
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
  const usageLimitFailures = new Map<
    string,
    Map<string, { adapter: Adapter; cause: string; count: number }>
  >();
  const limitedAdaptersByJob = new Map<string, Set<Adapter>>();
  /**
   * When each `<jobId>:<role>` last finished a turn (D44). The delegation guard
   * needs to tell "has not answered" apart from "has not started", and a role
   * that has never produced a turn is the only case the guard acts on.
   */
  const lastTurnEndedAt = new Map<string, number>();
  /** Turns each `<jobId>:<role>` has finished, reported to the supervisor (D44). */
  const completedTurns = new Map<string, number>();
  // Loop/no-progress watchdog state (D14)
  const noProgressCounts = new Map<string, Map<string, number>>();
  const loopFingerprints = new Map<string, Map<string, { fp: string; count: number }>>();
  const loopEscalationCounts = new Map<string, number>();
  // Consecutive supervisor turns that routed nothing, keyed by job id (D36).
  const supervisorIdleTurns = new Map<string, number>();
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
  // Global job lifecycle push subscribers registered via job.watch.
  const jobWatchers = new Set<(frame: PushFrame) => boolean>();
  // Deferred close trigger for daemon.stop.
  let doClose: () => Promise<void> = async () => {};
  // Set the moment shutdown begins, so no new turns are queued behind the drain.
  let closing = false;
  // Pending deferred worktree reclamations, cancelled on shutdown.
  const reclaimTimers = new Set<ReturnType<typeof setTimeout>>();

  if (team) {
    emitTeamModelWarnings(team, "startup");
  }

  const emitJobUpdate = (jobId: string, status: JobStatus): void => {
    if (jobWatchers.size === 0) return;
    const job = store.getJob(jobId);
    const frame: PushFrame = {
      type: "push",
      event: "job.update",
      data: { job_id: jobId, status, updated_at: job?.updated_at ?? new Date().toISOString() },
    };
    for (const watcher of jobWatchers) {
      if (!watcher(frame)) jobWatchers.delete(watcher);
    }
  };

  const setStatus = (jobId: string, status: JobStatus): void => {
    store.setJobStatus(jobId, status);
    emitJobUpdate(jobId, status);
    if (status !== "running") {
      // Deferred: reclamation shells out to git several times, and no caller of
      // setStatus should pay for that before it can answer its own request. The
      // timer is tracked so shutdown can cancel it — firing after the store is
      // closed would throw out of a timer callback with nobody to catch it.
      const timer = setTimeout(() => {
        reclaimTimers.delete(timer);
        reclaimWorktrees(jobId);
      }, 0);
      reclaimTimers.add(timer);
    }
  };

  /**
   * Remove a finished job's worktrees when they hold nothing (D42). Worktrees
   * accumulated indefinitely — 167 of them, 20GB, against 112 jobs — because
   * reclaiming them was a manual `agvsr cleanup --apply` nobody ran.
   *
   * This reuses the exact classifier `agvsr cleanup` uses and removes only
   * SAFE_TO_REMOVE: clean, and fully merged into the right base (main for a job's
   * own worktree, the job branch for an instance's). Anything dirty, unmerged, or
   * unresolvable is left for a human, so nothing recoverable is discarded.
   */
  const reclaimWorktrees = (jobId: string): void => {
    if (closing || !autoReclaimEnabled()) return;
    const job = store.getJob(jobId);
    if (!job || job.status === "running") return;

    const root = git(job.cwd, ["rev-parse", "--show-toplevel"]);
    if (!root.ok || !root.stdout) return;
    const mainWorktree = root.stdout;

    // Instances first: an instance's base is the job branch, which the job's own
    // worktree still owns until it is reclaimed in turn.
    const targets: Array<{ path: string; branch: string | null; baseRef: string }> = [
      ...store
        .listRoleWorktrees(jobId)
        .map((rw) => ({ path: rw.worktree, branch: rw.branch, baseRef: job.branch ?? "main" })),
      ...(job.worktree ? [{ path: job.worktree, branch: job.branch, baseRef: "main" }] : []),
    ];

    const removed: string[] = [];
    /** Removed worktrees that held uncommitted work, and where it now lives. */
    const parked: string[] = [];
    for (const t of targets) {
      if (!t.path || t.path === mainWorktree) continue;
      if (!existsSync(t.path)) continue;
      const checkpoint = store.latestCheckpointFor(t.path);
      const assessment = assessWorktree(
        { path: t.path, branch: t.branch },
        job,
        mainWorktree,
        t.baseRef,
        checkpoint?.ref ?? null,
      );
      if (assessment.classification !== "SAFE_TO_REMOVE") {
        debug("worktree kept", { job: jobId, path: t.path, reason: assessment.reason });
        continue;
      }
      if (!git(mainWorktree, ["worktree", "remove", "--force", t.path]).ok) continue;
      // The branch can go: a checkpoint commit keeps its own history reachable
      // through the checkpoint ref, which is not tied to any branch.
      if (t.branch) git(mainWorktree, ["branch", "-D", t.branch]);
      removed.push(t.path);
      if (assessment.dirty && checkpoint) parked.push(`${t.path} → ${checkpoint.ref}`);
    }

    if (removed.length === 0) return;
    git(mainWorktree, ["worktree", "prune"]);
    createMsg({
      job_id: jobId,
      from_role: "daemon",
      to_role: "user",
      kind: "note",
      body:
        `Reclaimed ${removed.length} worktree(s) for this finished job (clean and fully ` +
        `merged):\n${removed.map((p) => `  ${p}`).join("\n")}\n` +
        (parked.length > 0
          ? `\nUncommitted work in these was parked first — recover with ` +
            `\`git restore --source <ref> -- .\` or \`git show <ref>\`:\n` +
            `${parked.map((p) => `  ${p}`).join("\n")}\n`
          : "") +
        `Set AGVSR_AUTO_RECLAIM=0 to keep them instead.`,
    });
  };

  /**
   * Variables from `env`-declared files for a job's cwd (D43). The repo root is
   * cached because this runs on every turn; the file contents deliberately are
   * not, so a value the human corrects mid-job reaches the next turn.
   */
  const repoRootCache = new Map<string, string | null>();
  const envFileVarsFor = (cwd: string, jobTeam: TeamConfig): Record<string, string> => {
    if (!jobTeam.worktree?.env_files) return {};
    let root = repoRootCache.get(cwd);
    if (root === undefined) {
      root = repoRootOf(cwd);
      repoRootCache.set(cwd, root);
    }
    if (!root) return {};
    try {
      return envFileVariables(root, jobTeam);
    } catch (e) {
      debug("env file read failed", { cwd, error: (e as Error).message });
      return {};
    }
  };

  /**
   * Why a supervisor escalation to the human is premature, or null to let it
   * through (D44).
   *
   * Deliberately narrow: it fires only while *no* worker has produced a turn in
   * this job and *every* outstanding delegation is younger than the window. In
   * that state there is nothing for the human to act on that waiting would not
   * also resolve. Once any worker has run, or the window passes, escalation is
   * the supervisor's call again — a genuine question is delayed by at most the
   * window, never lost.
   */
  const prematureEscalation = (job: Job, jobTeam: TeamConfig): string | null => {
    if (!delegationGuardEnabled()) return null;
    const pending = outstandingDelegations(store.listMessages(job.id), jobTeam);
    if (pending.length === 0) return null;
    for (const role of Object.keys(jobTeam.roles)) {
      if (role === SUPERVISOR) continue;
      if (lastTurnEndedAt.has(`${job.id}:${role}`)) return null;
    }
    const waitMs = minDelegationWaitMs(jobTeam.roles[SUPERVISOR]);
    const now = Date.now();
    const newestFirst = [...pending].sort(
      (a, b) => Date.parse(b.message.created_at) - Date.parse(a.message.created_at),
    );
    const oldest = newestFirst[newestFirst.length - 1]!;
    if (now - Date.parse(oldest.message.created_at) >= waitMs) return null;

    const ages = newestFirst
      .map((p) => `  ${p.role}: delegated ${describeAge(p.message.created_at, now)} ago, 0 turns`)
      .join("\n");
    return [
      `No worker has completed a turn yet, and every outstanding delegation is younger`,
      `than ${Math.round(waitMs / 1000)}s.`,
      ``,
      ages,
      ``,
      `Escalating now would ask the human to fix something that has not had a chance to`,
      `happen. Use agvsr_wait to park the job, or escalate again once the window passes.`,
    ].join("\n");
  };

  /**
   * Park a turn's uncommitted worktree state under a checkpoint ref (D46).
   * Best effort: a checkpoint that cannot be taken must never fail the turn
   * that produced the work, so every failure here is logged and dropped.
   */
  const checkpointWorktree = (job: Job, role: string, worktree: string): void => {
    if (!checkpointsEnabled()) return;
    // job.cwd is the human's checkout; only a provisioned worktree is ours to
    // snapshot, and a job without one has nothing isolated to lose.
    if (!job.worktree || worktree === job.cwd) return;
    try {
      const turn = store.lastCheckpointTurn(job.id, role) + 1;
      const ref = checkpointRef(job.id, role, turn);
      const checkpoint = createCheckpoint(worktree, ref);
      if (!checkpoint) return; // clean worktree, or git declined
      store.recordCheckpoint({
        job_id: job.id,
        role,
        worktree,
        turn,
        ref,
        sha: checkpoint.sha,
        tree: checkpoint.tree,
      });
      debug("checkpoint", { job: job.id, role, turn, ref, sha: checkpoint.sha });
    } catch (e) {
      debug("checkpoint failed", { job: job.id, role, error: (e as Error).message });
    }
  };

  /**
   * Facts about every delegate, prepended to each supervisor turn (D44).
   *
   * The supervisor that escalated "design is not responding" 30 seconds after
   * delegating was not lying — it had no way to tell "has not answered" from
   * "has not started". Both look identical from inside a turn. Every line here
   * is the daemon's own observation, not something an agent reported, so the
   * distinction is available before the supervisor has to act on it.
   *
   * The refusals in msg.send/msg.escalate remain the actual guarantee; this
   * only removes the excuse for needing them.
   */
  const delegationStatusBlock = (job: Job, jobTeam: TeamConfig): string => {
    if (!delegationGuardEnabled()) return "";
    const roles = Object.keys(jobTeam.roles).filter((r) => r !== SUPERVISOR);
    if (roles.length === 0) return "";

    const history = store.listMessages(job.id);
    const now = Date.now();
    const width = Math.max(...roles.map((r) => r.length));
    const lines = roles.map((role) => {
      const key = `${job.id}:${role}`;
      const turns = completedTurns.get(key) ?? 0;
      const pending = outstandingDelegation(history, role);
      const inFlight = turnStartedAt.has(key);
      const state = pending
        ? `awaiting reply, delegated ${describeAge(pending.created_at, now)} ago`
        : turns > 0
          ? "idle, last delegation answered"
          : "not delegated";
      return `  ${role.padEnd(width)} : ${state}, ${turns} turn(s) completed, in-flight: ${
        inFlight ? "yes" : "no"
      }`;
    });
    return [`[agvsr delegation status]`, ...lines, ``].join("\n");
  };

  /**
   * Run the job's declared verification against its worktree (D43 mechanism B),
   * with the same environment its roles had — otherwise the gate would recreate
   * the very gap it exists to detect. Returns null when there is nothing
   * configured or the run is satisfactory.
   */
  const runVerifyGate = (job: Job, jobTeam: TeamConfig | null): VerifyOutcome | null => {
    if (!verifyGateEnabled() || !jobTeam?.verify || !job.worktree) return null;
    const repoRoot = repoRootOf(job.cwd);
    if (!repoRoot) return null;
    const env = { ...envFileVarsFor(job.cwd, jobTeam), ...jobTeam.env };
    try {
      return checkVerifyGate(jobTeam.verify, job.worktree, repoRoot, env);
    } catch (e) {
      // A gate that cannot run is a gate that verified nothing; say so rather
      // than letting the completion through on an exception.
      return {
        ok: false,
        code: "verify_failed",
        message: `Verification could not be run: ${(e as Error).message}`,
      };
    }
  };

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

  const recordUsageLimit = (
    jobId: string,
    role: string,
    adapter: Adapter,
    cause: string,
  ): number => {
    const byRole = usageLimitFailures.get(jobId) ?? new Map();
    usageLimitFailures.set(jobId, byRole);
    const previous = byRole.get(role);
    const count =
      previous?.adapter === adapter && previous.cause === cause ? previous.count + 1 : 1;
    byRole.set(role, { adapter, cause, count });
    const limited = limitedAdaptersByJob.get(jobId) ?? new Set<Adapter>();
    limitedAdaptersByJob.set(jobId, limited);
    limited.add(adapter);
    return count;
  };

  const clearUsageLimit = (jobId: string, adapter: Adapter): void => {
    limitedAdaptersByJob.get(jobId)?.delete(adapter);
    const byRole = usageLimitFailures.get(jobId);
    if (!byRole) return;
    for (const [role, state] of byRole) {
      if (state.adapter === adapter) byRole.delete(role);
    }
  };

  /**
   * True when the supervisor has put a question to the human that is still
   * unanswered (D36). In that state the supervisor has nothing it *should* route
   * — the correct move is to wait — so a turn ending without routing is normal.
   */
  const isAwaitingUserReply = (jobId: string): boolean => {
    let askedAt = -1;
    let answeredAt = -1;
    const messages = store.listMessages(jobId); // ascending by created_at
    for (const [i, m] of messages.entries()) {
      if (m.from_role === SUPERVISOR && m.to_role === "user") askedAt = i;
      else if (m.from_role === "user") answeredAt = i;
    }
    return askedAt > answeredAt;
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
    // Only the supervisor delegates, so only it needs to know where its
    // delegates stand (D44).
    const turnMessage =
      role === SUPERVISOR ? `${delegationStatusBlock(job, jobTeam)}${message}` : message;
    // A role with its own isolated worktree (D27 — an array-expanded
    // implementation instance) dispatches there instead of the job's shared
    // worktree; every other role is unaffected (roleWt is null for them).
    const roleWt = store.getRoleWorktree(job.id, role);
    const effectiveCwd = roleWt?.worktree ?? job.worktree ?? job.cwd;
    const effectiveBranch = roleWt?.branch ?? job.branch;
    const systemPrompt = sessionId
      ? ""
      : composeCharter(
          jobTeam,
          role,
          {
            jobId: job.id,
            cwd: effectiveCwd,
            branch: effectiveBranch,
            isolatedWorktree: !!roleWt,
          },
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
        networkAccess: roleConfig.network_access,
        job,
        effectiveCwd,
        message: turnMessage,
        sessionId,
        systemPrompt,
        signal: ac.signal,
        hardTimeoutMs: hardMs,
        idleTimeoutMs: idleMs,
        onProgress: () => lastProgressAt.set(key, Date.now()),
        env: {
          // Variables read out of `env`-declared files (D43) sit lowest: they
          // reconstruct what the human's shell would have provided, and an
          // explicit team.yaml value is a deliberate choice that outranks them.
          ...envFileVarsFor(job.cwd, jobTeam),
          // Team/role env next: job-invariant host facts (a test DB URL, a token)
          // belong in team.yaml so each job stops rediscovering them and relaying
          // them through the human. agvsr's own variables are applied after, so a
          // config mistake cannot unwire the MCP shim.
          ...jobTeam.env,
          ...roleConfig.env,
          PATH: userPath,
          AGVSR_SOCK: endpoint,
          AGVSR_ROLE: role,
          AGVSR_JOB_ID: job.id,
          AGVSR_ALLOWED: allowedTargets(jobTeam, role).join(","),
          AGVSR_JOB_BRANCH: effectiveBranch ?? "",
          ...(job.workspace_id
            ? {
                HERDR_ENV: "1",
                HERDR_WORKSPACE_ID: job.workspace_id,
                ...(job.caller_pane_id ? { HERDR_PANE_ID: job.caller_pane_id } : {}),
                ...(job.herdr_session ? { HERDR_SESSION: job.herdr_session } : {}),
              }
            : {}),
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

    // Record accounting before the kill check below: the tokens were spent even if
    // the job was stopped mid-turn, and hiding that would understate the real cost (D32).
    if (result.outcome.usage) {
      store.recordTurnUsage({
        job_id: job.id,
        role,
        adapter: roleConfig.adapter,
        model: roleConfig.model,
        usage: result.outcome.usage,
      });
    }

    // Recorded before the kill check below, like usage above: the turn ran, and
    // the delegation guard must not keep treating this role as never-started.
    lastTurnEndedAt.set(`${job.id}:${role}`, Date.now());
    completedTurns.set(`${job.id}:${role}`, (completedTurns.get(`${job.id}:${role}`) ?? 0) + 1);

    // Park whatever the turn left uncommitted (D46). Ahead of the kill check on
    // purpose: a turn cut short mid-edit is exactly when the work is most at
    // risk, and a killed job's worktree is reclaimed like any other.
    checkpointWorktree(job, role, effectiveCwd);

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

    if (role === SUPERVISOR && routedByRole) supervisorIdleTurns.delete(job.id);

    if (
      role === SUPERVISOR &&
      result.outcome.exitCode === 0 &&
      statusAfterTurn === "running" &&
      finalText &&
      !routedByRole
    ) {
      // A supervisor waiting on the human has nothing it should route, and the
      // charter explicitly tells it to wait for approval — so this is a normal
      // place for a turn to end, not a dead job (D36). It used to hard-fail here,
      // stranding work that was otherwise fine. The job simply idles; if the human
      // never answers, the stall watchdog is what reports it.
      if (isAwaitingUserReply(job.id)) {
        debug("supervisor idle while awaiting user reply", { job: job.id });
        return;
      }

      const idleTurns = (supervisorIdleTurns.get(job.id) ?? 0) + 1;
      supervisorIdleTurns.set(job.id, idleTurns);

      if (idleTurns < MAX_SUPERVISOR_IDLE_TURNS) {
        // Nudge instead of failing. One unproductive turn is not a dead job, and
        // worker roles have always been given exactly this second chance below.
        const body =
          `Your last turn ended with assistant text but routed no message, and no ` +
          `question to the human is outstanding, so nothing will happen until you act ` +
          `(${idleTurns}/${MAX_SUPERVISOR_IDLE_TURNS} before the job is failed).\n\n` +
          `Route the work forward: delegate with agvsr_send, ask the human with ` +
          `agvsr_escalate, or finish with agvsr_complete/agvsr_fail. If you are genuinely ` +
          `blocked on something none of those can resolve, park the job with agvsr_wait ` +
          `instead of restating that you are waiting. Note that agvsr_status is read-only ` +
          `and does not count as routing.\n\n` +
          `Your last text:\n${finalText}`;
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

      const reason =
        `supervisor ended ${idleTurns} consecutive turns with assistant text but routed no ` +
        "message, with no question to the human outstanding; the text was saved to the audit " +
        "log, but no work was routed and the job cannot progress.";
      setStatus(job.id, "failed");
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
          reason = `${role} turn failed.\n\n${turnFailureDiagnostics(roleConfig.adapter, roleConfig.model, result.outcome.exitCode, result.outcome.stderrTail, result.outcome.stdoutTail)}`;
        }
        reason = appendRecoverableDirtyWorktreeNote(job, reason, store.listRoleWorktrees(job.id));
        setStatus(job.id, "failed");
        createMsg({
          job_id: job.id,
          from_role: "daemon",
          to_role: "user",
          kind: "failure",
          body: reason,
        });
        hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
      } else {
        const diagnostics = [result.outcome.stderrTail, result.outcome.stdoutTail, finalText]
          .filter(Boolean)
          .join("\n");
        const limitCause = diagnostics ? usageLimitCause(diagnostics) : null;
        if (limitCause) {
          const occurrence = recordUsageLimit(job.id, role, roleConfig.adapter, limitCause);
          const body = usageLimitEscalation(
            role,
            roleConfig.adapter,
            roleConfig.model,
            diagnostics,
            occurrence,
            jobTeam,
            limitedAdaptersByJob.get(job.id)!,
          );
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "escalation",
            body,
          });
          hook("on_supervisor_message", { event: "supervisor_message", job_id: job.id, body });
          return;
        }
        clearUsageLimit(job.id, roleConfig.adapter);
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
          const reason = appendRecoverableDirtyWorktreeNote(
            job,
            `${role} failed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).\n\n${turnFailureDiagnostics(roleConfig.adapter, roleConfig.model, result.outcome.exitCode, undefined)}`,
            store.listRoleWorktrees(job.id),
          );
          setStatus(job.id, "failed");
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: reason,
          });
          hook("on_job_failed", { event: "job_failed", job_id: job.id, goal: job.goal, reason });
        } else {
          const body = `${role} turn failed with exit code ${result.outcome.exitCode} (failure ${failures}/${threshold}). Supervisor must decide whether to retry, reassign, or fail the job.\n\n${turnFailureDiagnostics(roleConfig.adapter, roleConfig.model, result.outcome.exitCode, result.outcome.stderrTail, result.outcome.stdoutTail)}`;
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
      clearUsageLimit(job.id, roleConfig.adapter);
      const loopMsg = checkLoopSignal(job.id, role, roleConfig.adapter, result.events);
      if (loopMsg) {
        const escalations = (loopEscalationCounts.get(job.id) ?? 0) + 1;
        loopEscalationCounts.set(job.id, escalations);
        const maxLoop = maxLoopEscalations();
        if (escalations >= maxLoop) {
          const reason = appendRecoverableDirtyWorktreeNote(
            job,
            `${loopMsg} (${escalations} loop escalations reached threshold ${maxLoop}; Tier2 watchdog hard-fail).`,
            store.listRoleWorktrees(job.id),
          );
          setStatus(job.id, "failed");
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
    // Shutdown drains the dispatches that exist when it starts; anything queued
    // after that would outlive store.close() and blow up on a closed database.
    // Several result paths enqueue follow-up turns (the worker no-route escalation,
    // the supervisor idle nudge), so the guard belongs here rather than at each site.
    if (closing) {
      debug("dispatch refused, daemon closing", { job: job.id, role });
      return;
    }
    const key = `${job.id}:${role}`;
    stallNotified.delete(job.id);
    const previous = inflight.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => dispatchRole(job, role, message))
      .catch((e) => {
        const message = (e as Error).message;
        if (role === SUPERVISOR) {
          const reason = appendRecoverableDirtyWorktreeNote(
            job,
            message,
            store.listRoleWorktrees(job.id),
          );
          setStatus(job.id, "failed");
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: reason,
          });
          hook("on_job_failed", {
            event: "job_failed",
            job_id: job.id,
            goal: job.goal,
            reason,
          });
        } else {
          const failures = incrementFailure(job.id, role);
          const threshold = maxWorkerFailures();
          if (failures >= threshold) {
            const reason = appendRecoverableDirtyWorktreeNote(
              job,
              `${role} crashed ${failures} consecutive times (threshold ${threshold}); job hard-failed (Tier2 watchdog).`,
              store.listRoleWorktrees(job.id),
            );
            setStatus(job.id, "failed");
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
        const {
          goal,
          cwd,
          id: customId,
          workspace_id: workspaceId,
          caller_pane_id: callerPaneId,
          herdr_session: herdrSession,
        } = req.params;
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

        // Prefer this job's own project team.yaml (if its target repo has one)
        // over the daemon's global default, so one long-running daemon serves
        // multiple projects with different roles/adapters/models correctly.
        let jobTeam: TeamConfig;
        try {
          const perJobTeam = resolveJobTeam(normalizedCwd);
          if (perJobTeam) {
            jobTeam = perJobTeam;
          } else {
            const noTeam = requireTeam(req.id);
            if (noTeam) return noTeam;
            jobTeam = team!;
          }
        } catch (e) {
          return err(
            req.id,
            "invalid_team",
            `invalid team.yaml in ${normalizedCwd}: ${(e as Error).message}`,
          );
        }

        // Environment parity (D43). Runs before the job row exists: a worktree
        // holds only tracked files, so a test suite keyed off an ignored `.env`
        // silently runs a subset there and reports success. Refusing here — the
        // one place no agent has started yet — is what makes that unfakeable.
        if (envParityEnabled()) {
          const parityRoot = repoRootOf(normalizedCwd);
          if (parityRoot) {
            const unresolved = unresolvedEnvFiles(parityRoot, jobTeam);
            if (unresolved.length > 0) {
              return err(
                req.id,
                "env_parity_required",
                envParityErrorMessage(parityRoot, unresolved),
              );
            }
          }
        }

        // Resolve the herdr workspace label as an additional identifier (D30).
        // Best-effort: an unreachable/unknown herdr server just leaves the name
        // unset, it never blocks job creation.
        const workspaceName = workspaceId
          ? await herdrClient.resolveWorkspaceName(workspaceId, herdrSession)
          : null;
        const job = store.createJob(goal.trim(), normalizedCwd, customId, {
          workspace_id: workspaceId,
          workspace_name: workspaceName,
          caller_pane_id: callerPaneId,
          herdr_session: herdrSession,
        });

        // Provision git worktree for isolation. Fails the job immediately if the
        // source is a real git repo but worktree creation fails (accepted decision).
        try {
          const worktree = await provisionWorktree(normalizedCwd, job.id, job.branch!);
          if (worktree) {
            store.setJobWorktree(job.id, worktree);
            job.worktree = worktree;
            placeDeclaredEnvFiles(normalizedCwd, worktree, jobTeam);
          }
        } catch (e) {
          setStatus(job.id, "failed");
          store.createMessage({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "failure",
            body: `Worktree provisioning failed: ${(e as Error).message}`,
          });
          return err(req.id, "provisioning_failed", (e as Error).message);
        }

        // Provision one isolated worktree per array-expanded implementation
        // instance (D27) — identified by charter_role, not by re-deriving the
        // naming convention. Same fail-the-whole-job.create pattern as above.
        // Skipped when the job itself has no worktree (non-git/unborn cwd).
        if (job.worktree) {
          for (const [instanceRole, cfg] of Object.entries(jobTeam.roles)) {
            if (cfg.charter_role !== "implementation" || instanceRole === "implementation") {
              continue;
            }
            const instanceBranch = `${job.branch}--${instanceRole}`;
            try {
              const instanceWorktree = await provisionWorktree(
                normalizedCwd,
                `${job.id}--${instanceRole}`,
                instanceBranch,
              );
              if (instanceWorktree) {
                store.setRoleWorktree(job.id, instanceRole, instanceWorktree, instanceBranch);
                placeDeclaredEnvFiles(normalizedCwd, instanceWorktree, jobTeam);
              }
            } catch (e) {
              setStatus(job.id, "failed");
              store.createMessage({
                job_id: job.id,
                from_role: "daemon",
                to_role: "user",
                kind: "failure",
                body:
                  `Worktree provisioning failed for instance "${instanceRole}": ${(e as Error).message}. ` +
                  `Run \`agvsr cleanup\` to check for worktrees left behind by this job.`,
              });
              return err(req.id, "provisioning_failed", (e as Error).message);
            }
          }
        }

        debug("job created", { job: job.id, goal: job.goal, worktree: job.worktree });
        jobTeamSnapshots.set(job.id, jobTeam);
        createMsg({
          job_id: job.id,
          from_role: "user",
          to_role: SUPERVISOR,
          kind: "message",
          body: job.goal,
        });
        enqueueDispatch(job, SUPERVISOR, job.goal);
        emitJobUpdate(job.id, "running");
        return ok(req.id, { job });
      }

      case "job.list":
        return ok(req.id, { jobs: store.listJobs() });

      case "job.roleWorktrees":
        return ok(req.id, { roleWorktrees: store.listAllRoleWorktrees() });

      case "job.get": {
        const job = store.getJob(req.params.id);
        return job
          ? ok(req.id, { job, runtime: computeRuntime(job), usage: store.jobUsage(job.id) })
          : err(req.id, "not_found", `no job ${req.params.id}`);
      }

      case "usage.report": {
        const jobId = req.params?.job_id;
        if (jobId && !store.getJob(jobId)) return err(req.id, "not_found", `no job ${jobId}`);
        const windowMs = req.params?.window_ms;
        const bucketMs = req.params?.bucket_ms;
        if (windowMs === undefined) {
          if (bucketMs !== undefined) {
            return err(req.id, "bad_request", "bucket_ms requires window_ms");
          }
          return ok(req.id, store.usageReport(jobId));
        }
        const invalid = usageWindowError(windowMs, bucketMs);
        if (invalid) return err(req.id, "bad_request", invalid);

        const endMs = Date.now();
        const startMs = endMs - windowMs;
        const range = {
          start_at: new Date(startMs).toISOString(),
          end_at: new Date(endMs).toISOString(),
        };
        const report = store.usageReport(jobId, range);
        report.window = { ...range, window_ms: windowMs };
        report.rate_per_hour = usageRate(report.totals, windowMs);
        if (bucketMs !== undefined) {
          report.buckets = usageBuckets(store.usageBuckets(jobId, range), startMs, endMs);
        }
        return ok(req.id, report);
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
        let routedBody = body;
        let reworkScope: string[] | null = null;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (!body?.trim()) return err(req.id, "bad_request", "message body must not be empty");
        const routingTeam = jobTeamSnapshots.get(job_id) ?? team!;
        if (!isAllowed(routingTeam, from, to))
          return err(req.id, "forbidden", `${from} may not send to ${to}`);
        // Same guard as msg.escalate: reaching the human directly is the same
        // act, and leaving this path open would make the other one decorative.
        if (from === SUPERVISOR && to === "user") {
          const premature = prematureEscalation(job, routingTeam);
          if (premature) return err(req.id, "delegation_still_starting", premature);
        }
        const history = store.listMessages(job_id);
        if (from === SUPERVISOR && to === "qa" && !lastDesignHandoff(history)) {
          return err(
            req.id,
            "qa_design_required",
            "qa may only be delegated after design has handed a design to the supervisor",
          );
        }
        // Handoff artifact gate (D46). A worker citing artifacts must have
        // committed them: uncommitted work cannot be merged, blocks worktree
        // reclamation, and is lost outright if the job never reaches completion
        // (where the only existing commit check lives).
        if (refsGateEnabled() && to === SUPERVISOR && from !== SUPERVISOR) {
          const senderWt = store.getRoleWorktree(job_id, from);
          const worktree = senderWt?.worktree ?? job.worktree;
          const branch = senderWt?.branch ?? job.branch;
          if (worktree) {
            if (from === "design" && (!refs || refs.length === 0)) {
              return err(
                req.id,
                "design_refs_required",
                `A design handoff must cite the design artifacts in refs, so they can be ` +
                  `checked in, approved as a set, and re-checked when the design is revised.`,
              );
            }
            const problems = refs?.length ? uncommittedRefs(worktree, refs) : [];
            if (problems.length > 0) {
              return err(req.id, "refs_uncommitted", refsGateMessage(from, branch, problems));
            }
          }
        }
        // Decision ledger (D45). Stable decision ids turn an approved design
        // into mechanically checkable state instead of prose the supervisor
        // must remember across every rework round.
        if (decisionLedgerEnabled() && from === "design" && to === SUPERVISOR) {
          const senderWt = store.getRoleWorktree(job_id, from);
          const worktree = senderWt?.worktree ?? job.worktree;
          const decisions = worktree && refs?.length ? decisionsFromRefs(worktree, refs) : [];
          if (worktree && decisions.length === 0) {
            return err(
              req.id,
              "design_decisions_unparseable",
              `The design handoff contains no decision entries. Each decision must start ` +
                `with a stable id, for example "D-1: keep the access TTL at 24h".`,
            );
          }
          const approved = store.listDesignDecisions(job_id);
          if (approved.length > 0) {
            const scope = store.listDesignReworkScope(job_id);
            const drift = outOfScopeDrift(approved, decisions, scope);
            if (drift.length > 0) {
              return err(req.id, "approved_decision_reverted", driftMessage(drift, scope));
            }
          }
        }
        if (decisionLedgerEnabled() && from === SUPERVISOR && to === "design") {
          const approved = store.listDesignDecisions(job_id);
          if (approved.length > 0) {
            const scope = mentionedDecisions(body);
            if (scope.length === 0) {
              return err(
                req.id,
                "rework_scope_required",
                `A rework instruction must name the decision ids to change ` +
                  `(for example "revise D-1 and D-4; leave the rest unchanged").`,
              );
            }
            reworkScope = scope;
            routedBody += frozenNotice(approved, scope);
          }
        }
        if (hasOutstandingIdenticalDelegation(history, from, to, routedBody)) {
          return err(
            req.id,
            "duplicate_delegation",
            `an identical ${from} -> ${to} delegation is still awaiting a response`,
          );
        }
        // Delegation guard (D44). Nudging a delegate that has not run yet cannot
        // change anything: the message only queues behind the turn already
        // starting. The existing duplicate check compares message bodies, so a
        // reworded nudge ("進捗確認です") walked straight past it; this one does
        // not read the body at all.
        if (delegationGuardEnabled() && from === SUPERVISOR && to !== "user") {
          const pending = outstandingDelegation(history, to);
          const endedAt = lastTurnEndedAt.get(`${job_id}:${to}`);
          if (pending && (endedAt === undefined || endedAt < Date.parse(pending.created_at))) {
            return err(
              req.id,
              "delegate_not_started",
              `${to} has not completed a turn since you delegated to it ` +
                `(${describeAge(pending.created_at, Date.now())} ago). Sending it another ` +
                `message now cannot change anything. Use agvsr_wait to park the job until ` +
                `it reports back.`,
            );
          }
        }
        // Design-approval gate: hold supervisor → implementation until the human approves
        // the design. Only engages once a design handoff exists (jobs that skip design are
        // unaffected). The blocked handoff is not recorded or dispatched.
        if (designGateEnabled() && from === SUPERVISOR && isImplementationRole(to)) {
          const design = pendingDesignApproval(job, history);
          if (design) {
            const note = createMsg({
              job_id,
              from_role: "daemon",
              to_role: "user",
              kind: "escalation",
              body:
                `Design approval required before implementation.\n` +
                `The supervisor is trying to hand work to "${to}", but the current design ` +
                `has not been approved by you. Review it, then reply to approve:\n` +
                `  agvsr tell ${job_id} "approved"\n` +
                `or reply with the changes you want instead.`,
            });
            hook("on_supervisor_message", { event: "supervisor_message", job_id, body: note.body });
            return err(
              req.id,
              "approval_required",
              "human design approval required before implementation",
            );
          }
        }
        if (reworkScope) {
          store.setDesignReworkScope(job_id, reworkScope);
          store.clearDesignApproval(job_id);
        }
        const msg = createMsg({
          job_id,
          from_role: from,
          to_role: to,
          kind: "message",
          body: routedBody,
          refs,
        });
        if (to !== "user") {
          enqueueDispatch(job, to, routedBody);
        } else if (from === SUPERVISOR) {
          hook("on_supervisor_message", { event: "supervisor_message", job_id, body: routedBody });
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
        if (from === SUPERVISOR) {
          const premature = prematureEscalation(job, escalationTeam);
          if (premature) return err(req.id, "delegation_still_starting", premature);
        }
        // Worker escalations go to the supervisor; a supervisor escalation goes to the human
        // (routing it back to itself would be a no-op self-loop). This is the approval/blocker
        // channel the design-approval flow relies on.
        const escalateTo = from === SUPERVISOR ? "user" : SUPERVISOR;
        const msg = createMsg({
          job_id,
          from_role: from,
          to_role: escalateTo,
          kind: "escalation",
          body: reason,
        });
        if (escalateTo === SUPERVISOR) {
          enqueueDispatch(job, SUPERVISOR, `Escalation from ${from}:\n\n${reason}`);
        } else {
          hook("on_supervisor_message", { event: "supervisor_message", job_id, body: reason });
        }
        return ok(req.id, { queued: true, message: msg });
      }

      case "job.wait": {
        const noTeam = requireTeam(req.id);
        if (noTeam) return noTeam;
        const { from, job_id, reason } = req.params;
        const job = store.getJob(job_id);
        if (!job) return err(req.id, "not_found", `no job ${job_id}`);
        if (!reason?.trim()) return err(req.id, "bad_request", "wait reason must not be empty");
        // Only the supervisor can park a job. A worker that cannot continue must go
        // through agvsr_escalate so the supervisor actually learns about the blocker;
        // parking silently would strand the job with nobody watching it.
        if (from !== SUPERVISOR)
          return err(req.id, "forbidden", `${from} must use msg.escalate, not job.wait`);
        // Parking is a legitimate way for a supervisor turn to end: it has nothing it
        // should route because it is blocked on something the daemon cannot deliver (a
        // human action taken outside agvsr, a long-running external job). Recording it as
        // a message from the supervisor means the idle-turn detector sees the turn as
        // routed and stops nudging — before this existed, a blocked supervisor burned its
        // whole nudge budget restating "waiting" and then hard-failed a job whose work was
        // fine. Nothing is dispatched, so the job idles until a reply arrives; the stall
        // watchdog still reports it if nothing ever does.
        const msg = createMsg({
          job_id,
          from_role: from,
          to_role: "daemon",
          kind: "note",
          body: `Waiting (blocked): ${reason}`,
        });
        supervisorIdleTurns.delete(job_id);
        debug("supervisor parked on a blocker", { job: job_id, reason });
        return ok(req.id, { queued: true, message: msg });
      }

      case "review.request": {
        const { job_id: jobId, from_role: fromRole, reviewer_kind: reviewerKind } = req.params;
        const body = req.params.body?.trim();
        const job = store.getJob(jobId);
        if (!job) return err(req.id, "not_found", `no job ${jobId}`);

        const rejectReview = (code: string, message: string): Response => {
          createMsg({
            job_id: jobId,
            from_role: "daemon",
            to_role: fromRole,
            kind: "note",
            body: `Herdr review request rejected: code=${code}, reason=${message}`,
          });
          return err(req.id, code, message);
        };

        if (job.status !== "running") {
          return rejectReview("review_job_not_running", `job ${jobId} is ${job.status}`);
        }
        if (!body) return rejectReview("bad_request", "review body must not be empty");
        if (!job.workspace_id) {
          return rejectReview("review_workspace_unavailable", "job has no saved Herdr workspace");
        }

        const reviewTeam = jobTeamSnapshots.get(jobId) ?? team;
        const requester = reviewTeam?.roles[fromRole];
        if (!requester) return rejectReview("forbidden", `unknown role ${fromRole}`);

        const listed = await herdrClient.listAgents(job.herdr_session);
        if (!listed.ok) {
          return rejectReview("herdr_unavailable", `${listed.code}: ${listed.message}`);
        }
        const resolution = resolveReviewAgent({
          agents: listed.agents,
          workspaceId: job.workspace_id,
          reviewerKind,
          requesterAdapter: requester.adapter,
          reviewerPaneId: req.params.reviewer_pane_id,
        });
        if (!resolution.ok) return rejectReview(resolution.code, resolution.message);

        const delivered = await herdrClient.promptAgentChecked(
          resolution.agent.pane_id,
          body,
          job.herdr_session,
        );
        if (!delivered.ok) {
          return rejectReview("review_delivery_failed", `${delivered.code}: ${delivered.message}`);
        }

        const preview = body.replaceAll(/\s+/g, " ").slice(0, 160);
        createMsg({
          job_id: jobId,
          from_role: fromRole,
          to_role: "daemon",
          kind: "note",
          body:
            `Herdr review requested: workspace=${job.workspace_id}` +
            `${job.workspace_name ? `(${job.workspace_name})` : ""}, ` +
            `reviewer=${reviewerKind}, pane=${resolution.agent.pane_id}, ` +
            `body_length=${body.length}, preview=${JSON.stringify(preview)}`,
        });
        return ok(req.id, {
          reviewer_pane_id: resolution.agent.pane_id,
          workspace_id: job.workspace_id,
          workspace_name: job.workspace_name,
          reviewer_kind: reviewerKind,
          reviewer_status: resolution.agent.agent_status,
        });
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

      case "job.watch": {
        const watcher = (frame: PushFrame): boolean => push(frame);
        jobWatchers.add(watcher);
        return ok(req.id, { watching: true });
      }

      case "job.complete": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        const gate = checkJobCommitGate(
          job,
          store.listRoleWorktrees(job.id).map((r) => r.worktree),
        );
        if (!gate.ok) {
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "escalation",
            body: gate.message,
          });
          return err(req.id, gate.code, gate.message);
        }
        // Independent verification (D43 mechanism B). Runs after the commit
        // gate so the tests exercise committed work, and the daemon runs it
        // itself — whatever the completing turn claimed about tests passing is
        // not read here.
        const completingTeam = jobTeamSnapshots.get(job.id) ?? team;
        const verifyOutcome = runVerifyGate(job, completingTeam);
        if (verifyOutcome) {
          createMsg({
            job_id: job.id,
            from_role: "daemon",
            to_role: "user",
            kind: "escalation",
            body: verifyOutcome.message,
          });
          return err(req.id, verifyOutcome.code, verifyOutcome.message);
        }
        setStatus(req.params.job_id, "done");
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

      case "job.mergeInstance": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        if (!job.worktree) return err(req.id, "bad_request", "job has no worktree to merge into");

        const roleWt = store.getRoleWorktree(job.id, req.params.role);
        if (!roleWt) {
          return err(
            req.id,
            "not_found",
            `no instance worktree for role "${req.params.role}" on job ${job.id}`,
          );
        }

        const instanceGate = checkJobCommitGate({ id: job.id, worktree: roleWt.worktree });
        if (!instanceGate.ok) {
          return err(
            req.id,
            instanceGate.code,
            `Instance "${req.params.role}" has uncommitted work — commit it before merging.\n${instanceGate.message}`,
          );
        }

        const result = mergeInstanceBranch(job.worktree, roleWt.branch);
        if (!result.ok) return err(req.id, result.code, result.message);
        return ok(req.id, { summary: result.summary });
      }

      case "job.fail": {
        const job = store.getJob(req.params.job_id);
        if (!job) return err(req.id, "not_found", `no job ${req.params.job_id}`);
        const reason = appendRecoverableDirtyWorktreeNote(
          job,
          req.params.reason,
          store.listRoleWorktrees(job.id),
        );
        setStatus(req.params.job_id, "failed");
        createMsg({
          job_id: req.params.job_id,
          from_role: SUPERVISOR,
          to_role: "user",
          kind: "failure",
          body: reason,
        });
        hook("on_job_failed", {
          event: "job_failed",
          job_id: job.id,
          goal: job.goal,
          reason,
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
        const verdict = approvalVerdict(body);
        if (decisionLedgerEnabled() && verdict === "reject") {
          const approved = store.listDesignDecisions(job_id);
          if (approved.length > 0) {
            const scope = mentionedDecisions(body);
            if (scope.length === 0) {
              return err(
                req.id,
                "rework_scope_required",
                `A design rejection must name the decision ids to change ` +
                  `(for example "revise D-1 and D-4; leave the rest unchanged").`,
              );
            }
            store.setDesignReworkScope(job_id, scope);
          }
        }
        let approvedDesign:
          | { refs: string[]; decisions: ReturnType<typeof decisionsFromRefs> }
          | undefined;
        if (verdict === "approve") {
          const design = lastDesignHandoff(store.listMessages(job_id));
          if (design) {
            const designRefs = refsOf(design);
            const designWt = store.getRoleWorktree(job_id, "design");
            const worktree = designWt?.worktree ?? job.worktree;
            const decisions = worktree ? decisionsFromRefs(worktree, designRefs) : [];
            if (decisionLedgerEnabled() && worktree && decisions.length === 0) {
              return err(
                req.id,
                "design_decisions_unparseable",
                "The design being approved contains no stable D-n decision entries.",
              );
            }
            approvedDesign = { refs: designRefs, decisions };
          }
        }
        const msg = createMsg({
          job_id,
          from_role: "user",
          to_role: SUPERVISOR,
          kind: "message",
          body,
        });
        // The human's verdict on the design is latched onto the job here rather than
        // re-read from the tail of the log later, so a later unrelated message ("here is
        // the test DB URL") cannot silently revoke it.
        if (verdict === "approve") {
          if (approvedDesign) {
            store.setDesignApproval(job_id, msg.created_at, approvedDesign.refs);
            if (decisionLedgerEnabled() && approvedDesign.decisions.length > 0) {
              store.replaceDesignDecisions(job_id, msg.created_at, approvedDesign.decisions);
            }
          }
        } else if (verdict === "reject") {
          store.clearDesignApproval(job_id);
        }
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
        setStatus(req.params.job_id, "failed");
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
        setStatus(req.params.job_id, "interrupted");
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
        // Reply first, then shut down and — for a real `agvsr daemon` process —
        // exit. Without the exit, anything still referencing the event loop keeps
        // a socket-less process alive indefinitely.
        //
        // A macrotask, not a microtask: the transport writes this response in the
        // continuation right after `await handler(...)`, which is itself a
        // microtask. Closing on a microtask would end the client's socket first
        // and the reply would never be sent, hanging `agvsr daemon stop`.
        setTimeout(() => {
          void (async () => {
            await doClose();
            if (options.exitOnStop) exitProcess(0);
          })();
        }, 0);
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
    closing = true;
    for (const timer of reclaimTimers) clearTimeout(timer);
    reclaimTimers.clear();
    if (stallWatchdog) {
      clearInterval(stallWatchdog);
      stallWatchdog = null;
    }
    // Stop accepting work *before* draining. A turn may legitimately run for the
    // full hard timeout (1h by default), and draining first kept the endpoint
    // bound for that whole window after `daemon stop` had already reported
    // success — long enough for a restart to collide with it.
    await server.close();
    if (!(await drainPending(pendingDispatches, drainMs))) {
      // Past the budget: abort the stragglers so their adapter subprocesses are
      // killed rather than orphaned when the process goes away, then give the
      // aborted turns a brief window to settle.
      debug("drain budget exceeded, aborting in-flight turns", { pending: pendingDispatches.size });
      for (const controllers of jobKillControllers.values()) {
        for (const ac of controllers) ac.abort();
      }
      await drainPending(pendingDispatches, ABORT_GRACE_MS);
    }
    if (ownsStore) store.close();
  };
  doClose = close;

  return { endpoint, close };
}
