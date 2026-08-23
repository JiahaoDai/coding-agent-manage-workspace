import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../shared/session';
import type { TeamMemberRecord, TeamRecord, TeamWithMembers } from '../shared/team';

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
        model           TEXT,
        last_error      TEXT,
        create_time     INTEGER NOT NULL,
        modify_time     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_agent_status_cwd
        ON session (coding_agent, status, cwd);

      CREATE TABLE IF NOT EXISTS team (
        team_id              TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        cwd                  TEXT NOT NULL,
        status               TEXT NOT NULL,
        max_parallel_members INTEGER NOT NULL,
        create_time          INTEGER NOT NULL,
        modify_time          INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_member (
        member_id             TEXT PRIMARY KEY,
        team_id               TEXT NOT NULL,
        role                  TEXT NOT NULL,
        coding_agent          TEXT NOT NULL,
        session_id            TEXT NOT NULL UNIQUE,
        model                 TEXT,
        responsibility_prompt TEXT NOT NULL,
        status                TEXT NOT NULL,
        current_delivery_id   TEXT,
        create_time           INTEGER NOT NULL,
        modify_time           INTEGER NOT NULL,
        UNIQUE(team_id, role)
      );

      CREATE INDEX IF NOT EXISTS idx_team_member_team
        ON team_member (team_id);
    `);

    // `CREATE TABLE IF NOT EXISTS` cannot amend installations created before
    // ticket 02. Keep this migration idempotent so their session metadata and
    // native-session mapping survive the upgrade.
    const columns = db.prepare(`PRAGMA table_info(session)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'last_error')) {
      db.exec(`ALTER TABLE session ADD COLUMN last_error TEXT`);
    }
    if (!columns.some((column) => column.name === 'model')) {
      db.exec(`ALTER TABLE session ADD COLUMN model TEXT`);
    }
  }

  insert(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session
           (session_id, coding_agent, real_session_id, name, cwd, status, model, last_error, create_time, modify_time)
         VALUES
           (@session_id, @coding_agent, @real_session_id, @name, @cwd, @status, @model, @last_error, @create_time, @modify_time)`,
      )
      .run(session);
  }

  list(): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, coding_agent, real_session_id, name, cwd, status, model, last_error, create_time, modify_time
         FROM session ORDER BY modify_time DESC`,
      )
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  listVisibleSessions(): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, coding_agent, real_session_id, name, cwd, status, model, last_error, create_time, modify_time
         FROM session
         WHERE session_id NOT IN (SELECT session_id FROM team_member)
         ORDER BY modify_time DESC`,
      )
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  get(session_id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id, coding_agent, real_session_id, name, cwd, status, model, last_error, create_time, modify_time
         FROM session WHERE session_id = ?`,
      )
      .get(session_id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  updateStatus(session_id: string, status: SessionStatus): void {
    this.db
      .prepare(
        `UPDATE session
         SET status = ?,
             last_error = CASE WHEN ? = 'completed' THEN NULL ELSE last_error END,
             modify_time = ?
         WHERE session_id = ?`,
      )
      .run(status, status, Date.now(), session_id);
  }

  /** Persist a real adapter/SDK failure. Deliberately separate from ordinary
   * status writes so callers for user-owned shell commands cannot accidentally
   * turn a non-zero exit into an agent-session error. */
  recordError(session_id: string, message: string): void {
    this.db
      .prepare(`UPDATE session SET status = 'error', last_error = ?, modify_time = ? WHERE session_id = ?`)
      .run(message, Date.now(), session_id);
  }

  updateModel(session_id: string, model: string | null): void {
    this.db.prepare(`UPDATE session SET model = ?, modify_time = ? WHERE session_id = ?`).run(model, Date.now(), session_id);
  }

  delete(session_id: string): void {
    this.db.prepare(`DELETE FROM session WHERE session_id = ?`).run(session_id);
  }

  isTeamMemberSession(session_id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM team_member WHERE session_id = ? LIMIT 1`)
      .get(session_id) as { 1: number } | undefined;
    return row !== undefined;
  }

  insertTeam(team: TeamRecord, members: TeamMemberRecord[]): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO team
             (team_id, name, cwd, status, max_parallel_members, create_time, modify_time)
           VALUES
             (@team_id, @name, @cwd, @status, @max_parallel_members, @create_time, @modify_time)`,
        )
        .run(team);

      const insertMember = this.db.prepare(
        `INSERT INTO team_member
           (member_id, team_id, role, coding_agent, session_id, model, responsibility_prompt,
            status, current_delivery_id, create_time, modify_time)
         VALUES
           (@member_id, @team_id, @role, @coding_agent, @session_id, @model, @responsibility_prompt,
            @status, @current_delivery_id, @create_time, @modify_time)`,
      );
      for (const member of members) insertMember.run(member);
    });

    insert();
  }

  listTeams(): TeamWithMembers[] {
    const teams = this.db
      .prepare(
        `SELECT team_id, name, cwd, status, max_parallel_members, create_time, modify_time
         FROM team ORDER BY modify_time DESC`,
      )
      .all() as TeamRow[];
    return teams.map((team) => ({ ...toTeam(team), members: this.listTeamMembers(team.team_id) }));
  }

  getTeam(team_id: string): TeamWithMembers | undefined {
    const row = this.db
      .prepare(
        `SELECT team_id, name, cwd, status, max_parallel_members, create_time, modify_time
         FROM team WHERE team_id = ?`,
      )
      .get(team_id) as TeamRow | undefined;
    return row ? { ...toTeam(row), members: this.listTeamMembers(team_id) } : undefined;
  }

  deleteTeam(team_id: string): boolean {
    const remove = this.db.transaction(() => {
      const sessionRows = this.db
        .prepare(`SELECT session_id FROM team_member WHERE team_id = ?`)
        .all(team_id) as Array<{ session_id: string }>;
      const deletedTeam = this.db.prepare(`DELETE FROM team WHERE team_id = ?`).run(team_id);
      if (deletedTeam.changes === 0) return false;

      this.db.prepare(`DELETE FROM team_member WHERE team_id = ?`).run(team_id);
      const deleteSession = this.db.prepare(`DELETE FROM session WHERE session_id = ?`);
      for (const row of sessionRows) deleteSession.run(row.session_id);
      return true;
    });

    return remove();
  }

  private listTeamMembers(team_id: string): TeamMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT member_id, team_id, role, coding_agent, session_id, model, responsibility_prompt,
                status, current_delivery_id, create_time, modify_time
         FROM team_member WHERE team_id = ? ORDER BY create_time ASC`,
      )
      .all(team_id) as TeamMemberRow[];
    return rows.map(toTeamMember);
  }
}

interface SessionRow {
  session_id: string;
  coding_agent: string;
  real_session_id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  model: string | null;
  last_error: string | null;
  create_time: number;
  modify_time: number;
}

function toSession(row: SessionRow): SessionRecord {
  return { ...row };
}

interface TeamRow {
  team_id: string;
  name: string;
  cwd: string;
  status: TeamRecord['status'];
  max_parallel_members: number;
  create_time: number;
  modify_time: number;
}

interface TeamMemberRow {
  member_id: string;
  team_id: string;
  role: string;
  coding_agent: string;
  session_id: string;
  model: string | null;
  responsibility_prompt: string;
  status: TeamMemberRecord['status'];
  current_delivery_id: string | null;
  create_time: number;
  modify_time: number;
}

function toTeam(row: TeamRow): TeamRecord {
  return { ...row };
}

function toTeamMember(row: TeamMemberRow): TeamMemberRecord {
  return { ...row };
}
