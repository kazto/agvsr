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
`;

const now = (): string => new Date().toISOString();

export interface WebSessionRow {
  session_hash: string;
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

  close(): void {
    this.db.close();
  }
}
