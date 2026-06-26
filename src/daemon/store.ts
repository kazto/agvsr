/**
 * SQLite store (D13). The daemon is the ONLY writer (single-writer model), which
 * sidesteps the multi-process write contention that hurt agmsg on Windows.
 * Not a message bus and not polled — routing is in-memory; this is the durable
 * queue + audit ledger.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Job, JobStatus, Message, MessageKind } from "../protocol.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  cwd        TEXT NOT NULL,
  branch     TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  from_role  TEXT NOT NULL,
  to_role    TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- message | escalation | completion | failure (D24)
  body       TEXT NOT NULL,
  refs       TEXT,                     -- JSON array of workspace paths
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(to_role, read_at) WHERE read_at IS NULL;
`;

const now = (): string => new Date().toISOString();

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  createJob(goal: string, cwd: string): Job {
    const ts = now();
    const job: Job = {
      id: randomUUID(),
      goal,
      status: "running",
      cwd,
      branch: null,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .query(
        `INSERT INTO jobs (id, goal, status, cwd, branch, created_at, updated_at)
         VALUES ($id, $goal, $status, $cwd, $branch, $created_at, $updated_at)`,
      )
      .run({
        $id: job.id,
        $goal: job.goal,
        $status: job.status,
        $cwd: job.cwd,
        $branch: job.branch,
        $created_at: job.created_at,
        $updated_at: job.updated_at,
      });
    return job;
  }

  getJob(id: string): Job | null {
    return (this.db.query(`SELECT * FROM jobs WHERE id = $id`).get({ $id: id }) as Job) ?? null;
  }

  listJobs(): Job[] {
    return this.db.query(`SELECT * FROM jobs ORDER BY created_at DESC`).all() as Job[];
  }

  setJobStatus(id: string, status: JobStatus): void {
    this.db
      .query(`UPDATE jobs SET status = $status, updated_at = $ts WHERE id = $id`)
      .run({ $status: status, $ts: now(), $id: id });
  }

  createMessage(input: {
    job_id: string;
    from_role: string;
    to_role: string;
    kind: MessageKind;
    body: string;
    refs?: string[];
  }): Message {
    const msg: Message = {
      id: randomUUID(),
      job_id: input.job_id,
      from_role: input.from_role,
      to_role: input.to_role,
      kind: input.kind,
      body: input.body,
      refs: input.refs ? JSON.stringify(input.refs) : null,
      created_at: now(),
      read_at: null,
    };
    this.db
      .query(
        `INSERT INTO messages (id, job_id, from_role, to_role, kind, body, refs, created_at, read_at)
         VALUES ($id, $job_id, $from_role, $to_role, $kind, $body, $refs, $created_at, $read_at)`,
      )
      .run({
        $id: msg.id,
        $job_id: msg.job_id,
        $from_role: msg.from_role,
        $to_role: msg.to_role,
        $kind: msg.kind,
        $body: msg.body,
        $refs: msg.refs,
        $created_at: msg.created_at,
        $read_at: msg.read_at,
      });
    return msg;
  }

  listMessages(jobId: string): Message[] {
    return this.db
      .query(`SELECT * FROM messages WHERE job_id = $job_id ORDER BY created_at ASC`)
      .all({ $job_id: jobId }) as Message[];
  }

  markMessageRead(id: string): void {
    this.db.query(`UPDATE messages SET read_at = $ts WHERE id = $id`).run({ $ts: now(), $id: id });
  }

  close(): void {
    this.db.close();
  }
}
