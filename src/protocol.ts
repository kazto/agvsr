/**
 * Wire protocol between the `agvsr` CLI client and the `agvsrd` daemon (D6/D18).
 * Newline-delimited JSON; each request gets exactly one response, correlated by id.
 * A single connection may carry many request/response pairs and, later, server
 * push frames (for `logs -f`, D15) — hence the discriminated `type`.
 */

export type JobStatus = "running" | "done" | "failed" | "interrupted";

export interface Job {
  id: string;
  goal: string;
  status: JobStatus;
  cwd: string;
  branch: string | null;
  worktree: string | null;
  created_at: string;
  updated_at: string;
  /** herdr mode fields (null in standalone mode, D29/D30). */
  workspace_id: string | null;
  /** Resolved herdr workspace `label`, cached at job-create time. */
  workspace_name: string | null;
  /** Pane that submitted the job — the "front-desk" escalation target (D31). */
  caller_pane_id: string | null;
  /** HERDR_SESSION of the submitting process, passed through to herdr CLI calls. */
  herdr_session: string | null;
  /**
   * When the human approved the current design (D-gate). Durable job state rather
   * than something re-derived from the tail of the message log, so that ordinary
   * follow-up messages from the human do not silently revoke an approval.
   */
  design_approved_at: string | null;
  /**
   * JSON array of the `refs` carried by the design handoff that was approved. A later
   * design handoff re-gates only if it touches artifacts outside this set.
   */
  design_approved_refs: string | null;
}

/** A role instance's dedicated worktree/branch (D27 — array-expanded
 * `implementation-N` instances, each isolated from the job's shared one). */
export interface RoleWorktree {
  job_id: string;
  role: string;
  worktree: string;
  branch: string;
}

/**
 * Live execution state of a job, computed at request time (not persisted).
 * Lets a client distinguish "running and actively working" from "running but
 * idle/stalled" — a distinction `status` alone cannot express.
 */
export interface JobRuntime {
  /** True if at least one turn is queued or running for this job right now. */
  in_flight: boolean;
  /** Roles with a queued or running turn right now. */
  active_roles: string[];
  /** ISO timestamp of the most recent audit message, or null if none. */
  last_activity_at: string | null;
  /** Milliseconds since last_activity_at, computed when the response is built. */
  idle_ms: number | null;
  /** ISO timestamps of when the current turn started per in-flight role. */
  turn_started_at?: Record<string, string>;
  /** Hard timeout remaining ms per in-flight role (0 when expired). */
  hard_remaining_ms?: Record<string, number>;
  /** ISO timestamps of last stdout progress per in-flight role (Tier 2). */
  last_progress_at?: Record<string, string>;
  /** Ms since last stdout progress per in-flight role (Tier 2). */
  idle_since_progress_ms?: Record<string, number>;
}

/**
 * Aggregated turn accounting (D32). Token counts are normalized across adapters
 * (`input_tokens` is always uncached input). `cost_usd` only accumulates what the
 * adapters actually report — today that is claude-code alone — so `cost_partial`
 * marks a group whose cost is a lower bound rather than a full figure.
 */
export interface UsageTotals {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  /** True when at least one turn in the group reported no cost. */
  cost_partial: boolean;
}

/** Per role/adapter/model slice of a `UsageTotals` aggregate. */
export interface UsageBreakdown extends UsageTotals {
  role: string;
  adapter: string;
  model: string;
}

/** Per-job slice, used by the cross-job `usage.report`. */
export interface UsageByJob extends UsageTotals {
  job_id: string;
  goal: string;
  status: JobStatus;
}

export interface JobUsage {
  totals: UsageTotals;
  by_role: UsageBreakdown[];
}

/** Exact daemon-clock interval used by a windowed usage report (D38). */
export interface UsageWindow {
  start_at: string;
  end_at: string;
  window_ms: number;
}

/** Average consumption per wall-clock hour across the requested window (D39). */
export type UsageRate = UsageTotals;

/** One UTC-aligned hour intersected with the requested window (D39). */
export interface UsageBucket {
  start_at: string;
  end_at: string;
  partial: boolean;
  totals: UsageTotals;
}

export interface UsageReport {
  totals: UsageTotals;
  by_role: UsageBreakdown[];
  by_job: UsageByJob[];
  window?: UsageWindow;
  rate_per_hour?: UsageRate;
  buckets?: UsageBucket[];
}

export type MessageKind = "message" | "escalation" | "completion" | "failure" | "note";

export interface Message {
  id: string;
  job_id: string;
  from_role: string;
  to_role: string;
  kind: MessageKind;
  body: string;
  refs: string | null;
  created_at: string;
  read_at: string | null;
}

/** Requests the client can send. Keep methods coarse and explicit. */
export type Request =
  | { id: string; type: "request"; method: "ping"; params?: Record<string, never> }
  | {
      id: string;
      type: "request";
      method: "job.create";
      params: {
        goal: string;
        cwd: string;
        id?: string;
        /** herdr mode fields, set by the CLI when HERDR_ENV/HERDR_WORKSPACE_ID are present (D29). */
        workspace_id?: string;
        caller_pane_id?: string;
        herdr_session?: string;
      };
    }
  | { id: string; type: "request"; method: "job.list"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "job.roleWorktrees"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "job.get"; params: { id: string } }
  | { id: string; type: "request"; method: "team.get"; params?: Record<string, never> }
  | {
      id: string;
      type: "request";
      method: "msg.list";
      params: { job_id: string; mark_read?: boolean };
    }
  | {
      id: string;
      type: "request";
      method: "msg.send";
      params: { from: string; job_id: string; to: string; body: string; refs?: string[] };
    }
  | {
      id: string;
      type: "request";
      method: "msg.escalate";
      params: { from: string; job_id: string; reason: string };
    }
  | {
      id: string;
      type: "request";
      method: "job.wait";
      params: { from: string; job_id: string; reason: string };
    }
  | {
      id: string;
      type: "request";
      method: "review.request";
      params: {
        job_id: string;
        from_role: string;
        reviewer_kind: "claude" | "codex";
        body: string;
        reviewer_pane_id?: string;
      };
    }
  | {
      id: string;
      type: "request";
      method: "msg.watch";
      params: { job_id: string; mark_read?: boolean };
    }
  | { id: string; type: "request"; method: "job.watch"; params?: Record<string, never> }
  | {
      id: string;
      type: "request";
      method: "job.complete";
      params: { job_id: string; result: string };
    }
  | { id: string; type: "request"; method: "job.fail"; params: { job_id: string; reason: string } }
  | { id: string; type: "request"; method: "job.tell"; params: { job_id: string; body: string } }
  | { id: string; type: "request"; method: "job.stop"; params: { job_id: string } }
  | { id: string; type: "request"; method: "job.kill"; params: { job_id: string } }
  | {
      id: string;
      type: "request";
      method: "job.mergeInstance";
      params: { job_id: string; role: string };
    }
  | {
      id: string;
      type: "request";
      method: "usage.report";
      params?: { job_id?: string; window_ms?: number; bucket_ms?: number };
    }
  | { id: string; type: "request"; method: "daemon.stop"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "reload"; params?: Record<string, never> };

export type Method = Extract<Request, { type: "request" }>["method"];

/** Minimal lifecycle payload for job.update. Internal to daemon↔gateway; not Web Push. */
export interface JobUpdate {
  job_id: string;
  status: JobStatus;
  updated_at: string;
}

/** Server-initiated push frame. Discriminated by `event`. */
export type PushFrame =
  | { type: "push"; event: "msg.new"; data: Message }
  | { type: "push"; event: "job.update"; data: JobUpdate };

export interface ResponseOk<T = unknown> {
  id: string;
  type: "response";
  ok: true;
  result: T;
}
export interface ResponseErr {
  id: string;
  type: "response";
  ok: false;
  error: { code: string; message: string };
}
export type Response<T = unknown> = ResponseOk<T> | ResponseErr;

/** Result payload shapes per method. */
export interface PingResult {
  pong: true;
  version: string;
}
export interface RoleSummary {
  name: string;
  adapter: string;
  model: string;
}

export type Frame = Request | Response | PushFrame;
