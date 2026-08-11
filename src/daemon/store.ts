/**
 * SQLite store (D13). The daemon is the ONLY writer (single-writer model), which
 * sidesteps the multi-process write contention that hurt agmsg on Windows.
 * Not a message bus and not polled — routing is in-memory; this is the durable
 * queue + audit ledger.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Job,
  JobStatus,
  JobUsage,
  Message,
  MessageKind,
  RoleWorktree,
  UsageBreakdown,
  UsageReport,
  UsageTotals,
} from "../protocol.ts";
import type { TurnUsage } from "../adapters/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  goal           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  cwd            TEXT NOT NULL,
  branch         TEXT,
  worktree       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  workspace_id   TEXT,                  -- herdr mode only (D29/D30); NULL in standalone mode
  workspace_name TEXT,                  -- resolved herdr workspace label, cached at create time
  caller_pane_id TEXT,                  -- submitting pane, the front-desk escalation target (D31)
  herdr_session  TEXT                   -- HERDR_SESSION of the submitting process
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  from_role  TEXT NOT NULL,
  to_role    TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- message | escalation | completion | failure | note (D24/D5)
  body       TEXT NOT NULL,
  refs       TEXT,                     -- JSON array of workspace paths
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  job_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, role),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS job_role_worktrees (
  job_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  worktree   TEXT NOT NULL,
  branch     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, role),
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE TABLE IF NOT EXISTS turn_usage (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  role               TEXT NOT NULL,
  adapter            TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER,          -- uncached input, normalized across adapters (D32)
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens   INTEGER,
  cost_usd           REAL,             -- claude-code only; NULL means "not reported"
  created_at         TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_job ON turn_usage(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turn_usage_created_at ON turn_usage(created_at);
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
    this.migrate();
  }

  private migrate(): void {
    const cols = this.db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const has = (name: string): boolean => cols.some((c) => c.name === name);
    if (!has("worktree")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN worktree TEXT");
    }
    for (const col of ["workspace_id", "workspace_name", "caller_pane_id", "herdr_session"]) {
      if (!has(col)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
      }
    }
  }

  createJob(
    goal: string,
    cwd: string,
    id?: string,
    herdrInfo?: {
      workspace_id?: string | null;
      workspace_name?: string | null;
      caller_pane_id?: string | null;
      herdr_session?: string | null;
    },
  ): Job {
    const ts = now();
    const jobId = id ?? randomUUID();
    const branch = id ? `agvsr/${id}` : `agvsr/${jobId.slice(0, 8)}`;
    const job: Job = {
      id: jobId,
      goal,
      status: "running",
      cwd,
      branch,
      worktree: null,
      created_at: ts,
      updated_at: ts,
      workspace_id: herdrInfo?.workspace_id ?? null,
      workspace_name: herdrInfo?.workspace_name ?? null,
      caller_pane_id: herdrInfo?.caller_pane_id ?? null,
      herdr_session: herdrInfo?.herdr_session ?? null,
    };
    this.db
      .query(
        `INSERT INTO jobs (id, goal, status, cwd, branch, worktree, created_at, updated_at,
                            workspace_id, workspace_name, caller_pane_id, herdr_session)
         VALUES ($id, $goal, $status, $cwd, $branch, NULL, $created_at, $updated_at,
                 $workspace_id, $workspace_name, $caller_pane_id, $herdr_session)`,
      )
      .run({
        $id: jobId,
        $goal: job.goal,
        $status: job.status,
        $cwd: job.cwd,
        $branch: job.branch,
        $created_at: job.created_at,
        $updated_at: job.updated_at,
        $workspace_id: job.workspace_id,
        $workspace_name: job.workspace_name,
        $caller_pane_id: job.caller_pane_id,
        $herdr_session: job.herdr_session,
      });
    return job;
  }

  setJobWorktree(id: string, worktree: string): void {
    this.db
      .query(`UPDATE jobs SET worktree = $worktree, updated_at = $ts WHERE id = $id`)
      .run({ $worktree: worktree, $ts: now(), $id: id });
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

  interruptRunningJobs(): Job[] {
    const jobs = this.db.query(`SELECT * FROM jobs WHERE status = 'running'`).all() as Job[];
    const ts = now();
    this.db
      .query(`UPDATE jobs SET status = 'interrupted', updated_at = $ts WHERE status = 'running'`)
      .run({ $ts: ts });
    return jobs.map((j) => ({ ...j, status: "interrupted", updated_at: ts }));
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

  getAgentSession(jobId: string, role: string): string | null {
    const row = this.db
      .query(`SELECT session_id FROM agent_sessions WHERE job_id = $job_id AND role = $role`)
      .get({ $job_id: jobId, $role: role }) as { session_id: string } | null;
    return row?.session_id ?? null;
  }

  setAgentSession(jobId: string, role: string, sessionId: string): void {
    this.db
      .query(
        `INSERT INTO agent_sessions (job_id, role, session_id, updated_at)
         VALUES ($job_id, $role, $session_id, $updated_at)
         ON CONFLICT(job_id, role) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run({ $job_id: jobId, $role: role, $session_id: sessionId, $updated_at: now() });
  }

  setRoleWorktree(jobId: string, role: string, worktree: string, branch: string): void {
    this.db
      .query(
        `INSERT INTO job_role_worktrees (job_id, role, worktree, branch, created_at)
         VALUES ($job_id, $role, $worktree, $branch, $created_at)
         ON CONFLICT(job_id, role) DO UPDATE SET
           worktree = excluded.worktree,
           branch = excluded.branch`,
      )
      .run({
        $job_id: jobId,
        $role: role,
        $worktree: worktree,
        $branch: branch,
        $created_at: now(),
      });
  }

  getRoleWorktree(jobId: string, role: string): { worktree: string; branch: string } | null {
    const row = this.db
      .query(
        `SELECT worktree, branch FROM job_role_worktrees WHERE job_id = $job_id AND role = $role`,
      )
      .get({ $job_id: jobId, $role: role }) as { worktree: string; branch: string } | null;
    return row ?? null;
  }

  listRoleWorktrees(jobId: string): Array<{ role: string; worktree: string; branch: string }> {
    return this.db
      .query(`SELECT role, worktree, branch FROM job_role_worktrees WHERE job_id = $job_id`)
      .all({ $job_id: jobId }) as Array<{ role: string; worktree: string; branch: string }>;
  }

  listAllRoleWorktrees(): RoleWorktree[] {
    return this.db
      .query(`SELECT job_id, role, worktree, branch FROM job_role_worktrees`)
      .all() as RoleWorktree[];
  }

  /** Record one turn's accounting (D32). Turns whose CLI reported nothing are
   * never passed here, so a missing row means "unmeasured", not "zero". */
  recordTurnUsage(input: {
    job_id: string;
    role: string;
    adapter: string;
    model: string;
    usage: TurnUsage;
    /** Optional deterministic completion time for tests/imports; production uses now(). */
    recorded_at?: string;
  }): void {
    this.db
      .query(
        `INSERT INTO turn_usage (id, job_id, role, adapter, model, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, reasoning_tokens,
                                 cost_usd, created_at)
         VALUES ($id, $job_id, $role, $adapter, $model, $input_tokens, $output_tokens,
                 $cache_read_tokens, $cache_write_tokens, $reasoning_tokens,
                 $cost_usd, $created_at)`,
      )
      .run({
        $id: randomUUID(),
        $job_id: input.job_id,
        $role: input.role,
        $adapter: input.adapter,
        $model: input.model,
        $input_tokens: input.usage.input_tokens,
        $output_tokens: input.usage.output_tokens,
        $cache_read_tokens: input.usage.cache_read_tokens,
        $cache_write_tokens: input.usage.cache_write_tokens,
        $reasoning_tokens: input.usage.reasoning_tokens,
        $cost_usd: input.usage.cost_usd,
        $created_at: input.recorded_at ?? now(),
      });
  }

  /** Totals + per-role breakdown for one job. Powers `agvsr status <id>`. */
  jobUsage(jobId: string): JobUsage {
    return {
      totals: this.totalsWhere("job_id = $job_id", { $job_id: jobId }),
      by_role: this.breakdownWhere("job_id = $job_id", { $job_id: jobId }),
    };
  }

  /** Cross-job (or single-job) report. Powers `agvsr usage`. */
  usageReport(jobId?: string, range?: UsageRange): UsageReport {
    const filters = usageFilters(jobId, range);
    const { where, params } = filters;
    const by_job = this.db
      .query(
        `SELECT u.job_id AS job_id, j.goal AS goal, j.status AS status, ${TOTALS_COLUMNS}
         FROM turn_usage u LEFT JOIN jobs j ON j.id = u.job_id
         WHERE ${where}
         GROUP BY u.job_id
         ORDER BY cost_usd DESC, turns DESC`,
      )
      .all(params) as Array<TotalsRow & { job_id: string; goal: string | null; status: JobStatus }>;

    return {
      totals: this.totalsWhere(where, params),
      by_role: this.breakdownWhere(where, params),
      by_job: by_job.map((r) => ({
        ...toTotals(r),
        job_id: r.job_id,
        goal: r.goal ?? "(job deleted)",
        status: r.status ?? "interrupted",
      })),
    };
  }

  /** Sparse UTC-hour aggregates. The daemon clips/fills buckets against the exact window. */
  usageBuckets(jobId: string | undefined, range: UsageRange): UsageHourAggregate[] {
    const { where, params } = usageFilters(jobId, range);
    const rows = this.db
      .query(
        `SELECT strftime('%Y-%m-%dT%H:00:00Z', u.created_at) AS hour_start,
                ${TOTALS_COLUMNS}
         FROM turn_usage u WHERE ${where}
         GROUP BY hour_start
         ORDER BY hour_start ASC`,
      )
      .all(params) as Array<TotalsRow & { hour_start: string }>;
    return rows.map((row) => ({ hour_start: row.hour_start, totals: toTotals(row) }));
  }

  private totalsWhere(where: string, params: Record<string, string>): UsageTotals {
    const row = this.db
      .query(`SELECT ${TOTALS_COLUMNS} FROM turn_usage u WHERE ${where}`)
      .get(params) as TotalsRow | null;
    return toTotals(row);
  }

  private breakdownWhere(where: string, params: Record<string, string>): UsageBreakdown[] {
    const rows = this.db
      .query(
        `SELECT u.role AS role, u.adapter AS adapter, u.model AS model, ${TOTALS_COLUMNS}
         FROM turn_usage u WHERE ${where}
         GROUP BY u.role, u.adapter, u.model
         ORDER BY cost_usd DESC, turns DESC, role ASC`,
      )
      .all(params) as Array<TotalsRow & { role: string; adapter: string; model: string }>;
    return rows.map((r) => ({
      ...toTotals(r),
      role: r.role,
      adapter: r.adapter,
      model: r.model,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface UsageRange {
  start_at: string;
  end_at: string;
}

export interface UsageHourAggregate {
  hour_start: string;
  totals: UsageTotals;
}

function usageFilters(
  jobId?: string,
  range?: UsageRange,
): { where: string; params: Record<string, string> } {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (jobId) {
    clauses.push("u.job_id = $job_id");
    params.$job_id = jobId;
  }
  if (range) {
    clauses.push("u.created_at >= $start_at", "u.created_at < $end_at");
    params.$start_at = range.start_at;
    params.$end_at = range.end_at;
  }
  return { where: clauses.length > 0 ? clauses.join(" AND ") : "1 = 1", params };
}

/** Shared aggregate projection. `missing_cost` counts turns whose adapter reported
 * no cost, which is what makes a group's `cost_usd` a lower bound. */
const TOTALS_COLUMNS = `
  COUNT(*) AS turns,
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
  SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS missing_cost`;

interface TotalsRow {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  missing_cost: number;
}

function toTotals(row: TotalsRow | null): UsageTotals {
  return {
    turns: row?.turns ?? 0,
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    cache_read_tokens: row?.cache_read_tokens ?? 0,
    cache_write_tokens: row?.cache_write_tokens ?? 0,
    reasoning_tokens: row?.reasoning_tokens ?? 0,
    cost_usd: row?.cost_usd ?? 0,
    cost_partial: (row?.missing_cost ?? 0) > 0,
  };
}
