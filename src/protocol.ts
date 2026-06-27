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
      params: { goal: string; cwd: string; id?: string };
    }
  | { id: string; type: "request"; method: "job.list"; params?: Record<string, never> }
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
      method: "msg.watch";
      params: { job_id: string; mark_read?: boolean };
    }
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
  | { id: string; type: "request"; method: "daemon.stop"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "reload"; params?: Record<string, never> };

export type Method = Extract<Request, { type: "request" }>["method"];

/** Server-initiated push frame sent to clients subscribed via msg.watch. */
export interface PushFrame {
  type: "push";
  event: "msg.new";
  data: Message;
}

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
