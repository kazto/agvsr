import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS web_bootstrap_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS web_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT,
  operation TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  request_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_operation_audit_created
  ON web_operation_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_web_operation_audit_job
  ON web_operation_audit(job_id, created_at);
CREATE TABLE IF NOT EXISTS web_vapid_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`;

const now = (): string => new Date().toISOString();

export interface WebSessionRow {
  session_hash: string;
  created_at: string;
  last_seen_at: string;
}

export interface WebOperationAuditRow {
  id: number;
  session_hash: string | null;
  operation: string;
  job_id: string | null;
  status: string;
  error_code: string | null;
  request_summary: string;
  created_at: string;
  updated_at: string;
}

export interface CreateWebOperationAuditInput {
  session_hash: string | null;
  operation: string;
  job_id: string | null;
  status: string;
  error_code: string | null;
  request_summary: string;
}

export interface UpdateWebOperationAuditInput {
  id: number;
  job_id?: string | null;
  status?: string;
  error_code?: string | null;
}

export interface VapidKeysRow {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  last_seen_at: string;
}

export class WebAuthStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  setBootstrapToken(tokenHash: string): void {
    this.db
      .query(
        `INSERT INTO web_bootstrap_tokens (id, token_hash, created_at, used_at)
         VALUES (1, $token_hash, $created_at, NULL)
         ON CONFLICT(id) DO UPDATE SET
           token_hash = excluded.token_hash,
           created_at = excluded.created_at,
           used_at = NULL`,
      )
      .run({ $token_hash: tokenHash, $created_at: now() });
  }

  hasBootstrapToken(tokenHash: string): boolean {
    const row = this.db
      .query(`SELECT token_hash, used_at FROM web_bootstrap_tokens WHERE id = 1`)
      .get() as { token_hash: string; used_at: string | null } | null;
    return row !== null && row.token_hash === tokenHash && row.used_at === null;
  }

  consumeBootstrapToken(tokenHash: string): boolean {
    const res = this.db
      .query(
        `UPDATE web_bootstrap_tokens
         SET used_at = $used_at
         WHERE id = 1 AND token_hash = $token_hash AND used_at IS NULL`,
      )
      .run({ $used_at: now(), $token_hash: tokenHash });
    return res.changes > 0;
  }

  createSession(sessionHash: string): WebSessionRow {
    const row: WebSessionRow = {
      session_hash: sessionHash,
      created_at: now(),
      last_seen_at: now(),
    };
    this.db
      .query(
        `INSERT INTO web_sessions (session_hash, created_at, last_seen_at)
         VALUES ($session_hash, $created_at, $last_seen_at)`,
      )
      .run({
        $session_hash: row.session_hash,
        $created_at: row.created_at,
        $last_seen_at: row.last_seen_at,
      });
    return row;
  }

  getSession(sessionHash: string): WebSessionRow | null {
    return (
      (this.db
        .query(
          `SELECT session_hash, created_at, last_seen_at FROM web_sessions WHERE session_hash = $session_hash`,
        )
        .get({ $session_hash: sessionHash }) as WebSessionRow | null) ?? null
    );
  }

  touchSession(sessionHash: string): void {
    this.db
      .query(`UPDATE web_sessions SET last_seen_at = $ts WHERE session_hash = $session_hash`)
      .run({ $ts: now(), $session_hash: sessionHash });
  }

  deleteSession(sessionHash: string): void {
    this.db.query(`DELETE FROM web_sessions WHERE session_hash = $session_hash`).run({
      $session_hash: sessionHash,
    });
  }

  createWebOperationAudit(input: CreateWebOperationAuditInput): WebOperationAuditRow {
    const row = {
      session_hash: input.session_hash,
      operation: input.operation,
      job_id: input.job_id,
      status: input.status,
      error_code: input.error_code,
      request_summary: input.request_summary,
      created_at: now(),
      updated_at: now(),
    };
    const res = this.db
      .query(
        `INSERT INTO web_operation_audit (
           session_hash, operation, job_id, status, error_code, request_summary, created_at, updated_at
         ) VALUES (
           $session_hash, $operation, $job_id, $status, $error_code, $request_summary, $created_at, $updated_at
         )`,
      )
      .run({
        $session_hash: row.session_hash,
        $operation: row.operation,
        $job_id: row.job_id,
        $status: row.status,
        $error_code: row.error_code,
        $request_summary: row.request_summary,
        $created_at: row.created_at,
        $updated_at: row.updated_at,
      });
    return {
      id: Number(res.lastInsertRowid),
      ...row,
    };
  }

  updateWebOperationAudit(input: UpdateWebOperationAuditInput): void {
    const parts = ["updated_at = $updated_at"];
    const params: Record<string, string | number | null> = {
      $id: input.id,
      $updated_at: now(),
    };
    if (input.job_id !== undefined) {
      parts.push("job_id = $job_id");
      params.$job_id = input.job_id;
    }
    if (input.status !== undefined) {
      parts.push("status = $status");
      params.$status = input.status;
    }
    if (input.error_code !== undefined) {
      parts.push("error_code = $error_code");
      params.$error_code = input.error_code;
    }
    this.db.query(`UPDATE web_operation_audit SET ${parts.join(", ")} WHERE id = $id`).run(params);
  }

  listWebOperationAudit(limit = 100): WebOperationAuditRow[] {
    return this.db
      .query(
        `SELECT id, session_hash, operation, job_id, status, error_code, request_summary, created_at, updated_at
         FROM web_operation_audit
         ORDER BY id DESC
         LIMIT $limit`,
      )
      .all({ $limit: limit }) as WebOperationAuditRow[];
  }

  async getOrCreateVapidKeys(): Promise<VapidKeysRow> {
    const row = this.db
      .query(`SELECT public_key, private_key FROM web_vapid_keys WHERE id = 1`)
      .get() as { public_key: string; private_key: string } | null;
    if (row) return { publicKey: row.public_key, privateKey: row.private_key };

    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const privPkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const pubB64 = Buffer.from(pubRaw).toString("base64url");
    const privB64 = Buffer.from(privPkcs8).toString("base64url");
    this.db
      .query(
        `INSERT INTO web_vapid_keys (id, public_key, private_key, created_at)
         VALUES (1, $pub, $priv, $ts)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({ $pub: pubB64, $priv: privB64, $ts: now() });
    const saved = this.db
      .query(`SELECT public_key, private_key FROM web_vapid_keys WHERE id = 1`)
      .get() as { public_key: string; private_key: string };
    return { publicKey: saved.public_key, privateKey: saved.private_key };
  }

  getVapidPublicKey(): string | null {
    const row = this.db.query(`SELECT public_key FROM web_vapid_keys WHERE id = 1`).get() as {
      public_key: string;
    } | null;
    return row?.public_key ?? null;
  }

  addPushSubscription(sub: { endpoint: string; p256dh: string; auth: string }): void {
    const ts = now();
    this.db
      .query(
        `INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, created_at, last_seen_at)
         VALUES ($endpoint, $p256dh, $auth, $ts, $ts)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           last_seen_at = excluded.last_seen_at`,
      )
      .run({ $endpoint: sub.endpoint, $p256dh: sub.p256dh, $auth: sub.auth, $ts: ts });
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return this.db
      .query(`SELECT endpoint, p256dh, auth, created_at, last_seen_at FROM web_push_subscriptions`)
      .all() as PushSubscriptionRow[];
  }

  removePushSubscription(endpoint: string): void {
    this.db
      .query(`DELETE FROM web_push_subscriptions WHERE endpoint = $endpoint`)
      .run({ $endpoint: endpoint });
  }

  close(): void {
    this.db.close();
  }
}
