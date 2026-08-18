import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../shared/session';

/**
 * The app's own metadata store. Holds one row per session — message bodies are
 * never stored here; they are read from the agent's native store using
 * `real_session_id`.
 */
export class SessionStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        session_id      TEXT PRIMARY KEY,
        coding_agent    TEXT NOT NULL,
        real_session_id TEXT NOT NULL,
        name            TEXT NOT NULL,
        cwd             TEXT NOT NULL,
        status          TEXT NOT NULL,
        create_time     INTEGER NOT NULL,
        modify_time     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_agent_status_cwd
        ON session (coding_agent, status, cwd);
    `);
  }

  insert(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session
           (session_id, coding_agent, real_session_id, name, cwd, status, create_time, modify_time)
         VALUES
           (@session_id, @coding_agent, @real_session_id, @name, @cwd, @status, @create_time, @modify_time)`,
      )
      .run(session);
  }

  list(): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, coding_agent, real_session_id, name, cwd, status, create_time, modify_time
         FROM session ORDER BY modify_time DESC`,
      )
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  get(session_id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, coding_agent, real_session_id, name, cwd, status, create_time, modify_time
         FROM session WHERE session_id = ?`,
      )
      .get(session_id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  updateStatus(session_id: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE session SET status = ?, modify_time = ? WHERE session_id = ?`)
      .run(status, Date.now(), session_id);
  }

  delete(session_id: string): void {
    this.db.prepare(`DELETE FROM session WHERE session_id = ?`).run(session_id);
  }
}

interface SessionRow {
  session_id: string;
  coding_agent: string;
  real_session_id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  create_time: number;
  modify_time: number;
}

function toSession(row: SessionRow): SessionRecord {
  return { ...row };
}
