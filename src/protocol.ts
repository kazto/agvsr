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
  created_at: string;
  updated_at: string;
}

export type MessageKind = "message" | "escalation" | "completion" | "failure";

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
  | { id: string; type: "request"; method: "job.create"; params: { goal: string; cwd: string } }
  | { id: string; type: "request"; method: "job.list"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "job.get"; params: { id: string } }
  | { id: string; type: "request"; method: "team.get"; params?: Record<string, never> }
  | { id: string; type: "request"; method: "msg.list"; params: { job_id: string } }
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
      method: "job.complete";
      params: { job_id: string; result: string };
    }
  | { id: string; type: "request"; method: "job.fail"; params: { job_id: string; reason: string } };

export type Method = Extract<Request, { type: "request" }>["method"];

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

export type Frame = Request | Response;
