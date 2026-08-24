import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../shared/session';
import type {
  TeamDeliveryStatus,
  TeamDeliveryDependencyRecord,
  TeamDeliveryDependencyType,
  TeamMemberRecord,
  TeamMessageDeliveryRecord,
  TeamMessageRecord,
  TeamRecord,
  TeamRunRecord,
  TeamRunStatus,
  TeamRunWithItems,
  TeamStatus,
  TeamWithMembers,
} from '../shared/team';

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

      CREATE TABLE IF NOT EXISTS team_member_queue (
        member_id TEXT PRIMARY KEY,
        next_seq  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_run (
        run_id               TEXT PRIMARY KEY,
        team_id              TEXT NOT NULL,
        root_user_message_id TEXT NOT NULL,
        status               TEXT NOT NULL,
        max_rounds           INTEGER NOT NULL,
        current_round        INTEGER NOT NULL,
        create_time          INTEGER NOT NULL,
        finish_time          INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_team_run_team
        ON team_run (team_id, create_time);

      CREATE TABLE IF NOT EXISTS team_message (
        message_id     TEXT PRIMARY KEY,
        team_id        TEXT NOT NULL,
        run_id         TEXT NOT NULL,
        from_member_id TEXT,
        from_kind      TEXT NOT NULL,
        kind           TEXT NOT NULL,
        content        TEXT NOT NULL,
        create_time    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_team_message_run
        ON team_message (run_id, create_time);

      CREATE TABLE IF NOT EXISTS team_message_delivery (
        delivery_id  TEXT PRIMARY KEY,
        message_id   TEXT NOT NULL,
        team_id      TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        to_member_id TEXT NOT NULL,
        status       TEXT NOT NULL,
        enqueue_seq  INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        started_at   INTEGER,
        finished_at  INTEGER,
        error        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_team_delivery_run
        ON team_message_delivery (run_id, status, enqueue_seq);

      CREATE TABLE IF NOT EXISTS team_delivery_dependency (
        delivery_id            TEXT NOT NULL,
        depends_on_delivery_id TEXT NOT NULL,
        dependency_type        TEXT NOT NULL,
        PRIMARY KEY (delivery_id, depends_on_delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_team_dependency_upstream
        ON team_delivery_dependency (depends_on_delivery_id);
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

  updateTeamStatus(team_id: string, status: TeamStatus): void {
    this.db.prepare(`UPDATE team SET status = ?, modify_time = ? WHERE team_id = ?`).run(status, Date.now(), team_id);
  }

  updateTeamMemberStatus(
    member_id: string,
    status: TeamMemberRecord['status'],
    current_delivery_id: string | null,
  ): void {
    this.db
      .prepare(`UPDATE team_member SET status = ?, current_delivery_id = ?, modify_time = ? WHERE member_id = ?`)
      .run(status, current_delivery_id, Date.now(), member_id);
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
      const insertQueue = this.db.prepare(`INSERT INTO team_member_queue (member_id, next_seq) VALUES (?, 1)`);
      for (const member of members) {
        insertMember.run(member);
        insertQueue.run(member.member_id);
      }
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

      this.db
        .prepare(
          `DELETE FROM team_member_queue
           WHERE member_id IN (SELECT member_id FROM team_member WHERE team_id = ?)`,
        )
        .run(team_id);
      this.db.prepare(`DELETE FROM team_member WHERE team_id = ?`).run(team_id);
      this.db
        .prepare(
          `DELETE FROM team_delivery_dependency
           WHERE delivery_id IN (SELECT delivery_id FROM team_message_delivery WHERE team_id = ?)`,
        )
        .run(team_id);
      this.db.prepare(`DELETE FROM team_message_delivery WHERE team_id = ?`).run(team_id);
      this.db.prepare(`DELETE FROM team_message WHERE team_id = ?`).run(team_id);
      this.db.prepare(`DELETE FROM team_run WHERE team_id = ?`).run(team_id);
      const deleteSession = this.db.prepare(`DELETE FROM session WHERE session_id = ?`);
      for (const row of sessionRows) deleteSession.run(row.session_id);
      return true;
    });

    return remove();
  }

  createLeaderRun(input: {
    run_id: string;
    team_id: string;
    leader_member_id: string;
    user_message_id: string;
    delivery_id: string;
    content: string;
    now: number;
  }): TeamRunWithItems {
    const create = this.db.transaction(() => {
      const run: TeamRunRecord = {
        run_id: input.run_id,
        team_id: input.team_id,
        root_user_message_id: input.user_message_id,
        status: 'running',
        max_rounds: 1,
        current_round: 1,
        create_time: input.now,
        finish_time: null,
      };
      const message: TeamMessageRecord = {
        message_id: input.user_message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        from_member_id: null,
        from_kind: 'user',
        kind: 'user_request',
        content: input.content,
        create_time: input.now,
      };
      const delivery: TeamMessageDeliveryRecord = {
        delivery_id: input.delivery_id,
        message_id: input.user_message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        to_member_id: input.leader_member_id,
        status: 'pending',
        enqueue_seq: 1,
        created_at: input.now,
        started_at: null,
        finished_at: null,
        error: null,
      };

      this.insertTeamRun(run);
      this.insertTeamMessage(message);
      this.insertTeamDelivery(delivery);
      this.updateTeamStatus(input.team_id, 'running');
      return { run, messages: [message], deliveries: [delivery], dependencies: [] };
    });

    return create();
  }

  listTeamRuns(team_id: string): TeamRunWithItems[] {
    const runs = this.db
      .prepare(
        `SELECT run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time
         FROM team_run WHERE team_id = ? ORDER BY create_time ASC`,
      )
      .all(team_id) as TeamRunRow[];
    return runs.map((row) => {
      const run = toTeamRun(row);
      return {
        run,
        messages: this.listTeamMessages(run.run_id),
        deliveries: this.listTeamDeliveries(run.run_id),
        dependencies: this.listTeamDependencies(run.run_id),
      };
    });
  }

  getTeamRun(run_id: string): TeamRunWithItems | undefined {
    const row = this.db
      .prepare(
        `SELECT run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time
         FROM team_run WHERE run_id = ?`,
      )
      .get(run_id) as TeamRunRow | undefined;
    if (!row) return undefined;
    const run = toTeamRun(row);
    return {
      run,
      messages: this.listTeamMessages(run_id),
      deliveries: this.listTeamDeliveries(run_id),
      dependencies: this.listTeamDependencies(run_id),
    };
  }

  updateTeamDeliveryStatus(delivery_id: string, status: TeamDeliveryStatus, error: string | null = null): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE team_message_delivery
         SET status = ?,
             started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
             finished_at = CASE WHEN ? IN ('done', 'failed', 'cancelled') THEN ? ELSE finished_at END,
             error = ?
         WHERE delivery_id = ?`,
      )
      .run(status, status, now, status, now, error, delivery_id);
  }

  finishTeamRun(run_id: string, status: TeamRunStatus): TeamRunRecord {
    this.db
      .prepare(`UPDATE team_run SET status = ?, finish_time = ? WHERE run_id = ?`)
      .run(status, Date.now(), run_id);
    return this.getTeamRun(run_id)!.run;
  }

  insertTeamMessageRecord(message: TeamMessageRecord): void {
    this.insertTeamMessage(message);
  }

  createPlanDeliveries(input: {
    team_id: string;
    run_id: string;
    leader_member_id: string;
    plan_message_id: string;
    summary: string;
    assignments: Array<{
      message_id: string;
      delivery_id: string;
      to_member_id: string;
      content: string;
      blocked: boolean;
      dependencies: Array<{ depends_on_delivery_id: string; dependency_type: TeamDeliveryDependencyType }>;
    }>;
    now: number;
  }): {
    plan_message: TeamMessageRecord;
    assignment_messages: TeamMessageRecord[];
    deliveries: TeamMessageDeliveryRecord[];
    dependencies: TeamDeliveryDependencyRecord[];
  } {
    const create = this.db.transaction(() => {
      const plan_message: TeamMessageRecord = {
        message_id: input.plan_message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        from_member_id: input.leader_member_id,
        from_kind: 'member',
        kind: 'status',
        content: input.summary,
        create_time: input.now,
      };
      this.insertTeamMessage(plan_message);

      const assignment_messages: TeamMessageRecord[] = [];
      const deliveries: TeamMessageDeliveryRecord[] = [];
      const dependencies: TeamDeliveryDependencyRecord[] = [];
      for (const assignment of input.assignments) {
        const message: TeamMessageRecord = {
          message_id: assignment.message_id,
          team_id: input.team_id,
          run_id: input.run_id,
          from_member_id: input.leader_member_id,
          from_kind: 'member',
          kind: 'assignment',
          content: assignment.content,
          create_time: input.now + assignment_messages.length + 1,
        };
        const delivery: TeamMessageDeliveryRecord = {
          delivery_id: assignment.delivery_id,
          message_id: assignment.message_id,
          team_id: input.team_id,
          run_id: input.run_id,
          to_member_id: assignment.to_member_id,
          status: assignment.blocked ? 'blocked' : 'pending',
          enqueue_seq: this.nextMemberQueueSeq(assignment.to_member_id),
          created_at: input.now + assignment_messages.length + 1,
          started_at: null,
          finished_at: null,
          error: null,
        };

        this.insertTeamMessage(message);
        this.insertTeamDelivery(delivery);
        assignment_messages.push(message);
        deliveries.push(delivery);

        for (const dep of assignment.dependencies) {
          const dependency: TeamDeliveryDependencyRecord = {
            delivery_id: assignment.delivery_id,
            depends_on_delivery_id: dep.depends_on_delivery_id,
            dependency_type: dep.dependency_type,
          };
          this.insertTeamDependency(dependency);
          dependencies.push(dependency);
        }
      }

      return { plan_message, assignment_messages, deliveries, dependencies };
    });

    return create();
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

  private insertTeamRun(run: TeamRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_run
           (run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time)
         VALUES
           (@run_id, @team_id, @root_user_message_id, @status, @max_rounds, @current_round, @create_time, @finish_time)`,
      )
      .run(run);
  }

  private insertTeamMessage(message: TeamMessageRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_message
           (message_id, team_id, run_id, from_member_id, from_kind, kind, content, create_time)
         VALUES
           (@message_id, @team_id, @run_id, @from_member_id, @from_kind, @kind, @content, @create_time)`,
      )
      .run(message);
  }

  private insertTeamDelivery(delivery: TeamMessageDeliveryRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_message_delivery
           (delivery_id, message_id, team_id, run_id, to_member_id, status, enqueue_seq,
            created_at, started_at, finished_at, error)
         VALUES
           (@delivery_id, @message_id, @team_id, @run_id, @to_member_id, @status, @enqueue_seq,
            @created_at, @started_at, @finished_at, @error)`,
      )
      .run(delivery);
  }

  private insertTeamDependency(dependency: TeamDeliveryDependencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO team_delivery_dependency
           (delivery_id, depends_on_delivery_id, dependency_type)
         VALUES
           (@delivery_id, @depends_on_delivery_id, @dependency_type)`,
      )
      .run(dependency);
  }

  private nextMemberQueueSeq(member_id: string): number {
    this.db.prepare(`INSERT OR IGNORE INTO team_member_queue (member_id, next_seq) VALUES (?, 1)`).run(member_id);
    const row = this.db
      .prepare(`SELECT next_seq FROM team_member_queue WHERE member_id = ?`)
      .get(member_id) as { next_seq: number };
    this.db.prepare(`UPDATE team_member_queue SET next_seq = ? WHERE member_id = ?`).run(row.next_seq + 1, member_id);
    return row.next_seq;
  }

  private listTeamMessages(run_id: string): TeamMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, team_id, run_id, from_member_id, from_kind, kind, content, create_time
         FROM team_message WHERE run_id = ? ORDER BY create_time ASC`,
      )
      .all(run_id) as TeamMessageRow[];
    return rows.map(toTeamMessage);
  }

  private listTeamDeliveries(run_id: string): TeamMessageDeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT delivery_id, message_id, team_id, run_id, to_member_id, status, enqueue_seq,
                created_at, started_at, finished_at, error
         FROM team_message_delivery WHERE run_id = ? ORDER BY enqueue_seq ASC`,
      )
      .all(run_id) as TeamDeliveryRow[];
    return rows.map(toTeamDelivery);
  }

  private listTeamDependencies(run_id: string): TeamDeliveryDependencyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT d.delivery_id, d.depends_on_delivery_id, d.dependency_type
         FROM team_delivery_dependency d
         JOIN team_message_delivery delivery ON delivery.delivery_id = d.delivery_id
         WHERE delivery.run_id = ?
         ORDER BY delivery.enqueue_seq ASC`,
      )
      .all(run_id) as TeamDependencyRow[];
    return rows.map(toTeamDependency);
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

interface TeamRunRow {
  run_id: string;
  team_id: string;
  root_user_message_id: string;
  status: TeamRunRecord['status'];
  max_rounds: number;
  current_round: number;
  create_time: number;
  finish_time: number | null;
}

interface TeamMessageRow {
  message_id: string;
  team_id: string;
  run_id: string;
  from_member_id: string | null;
  from_kind: TeamMessageRecord['from_kind'];
  kind: TeamMessageRecord['kind'];
  content: string;
  create_time: number;
}

interface TeamDeliveryRow {
  delivery_id: string;
  message_id: string;
  team_id: string;
  run_id: string;
  to_member_id: string;
  status: TeamMessageDeliveryRecord['status'];
  enqueue_seq: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

interface TeamDependencyRow {
  delivery_id: string;
  depends_on_delivery_id: string;
  dependency_type: TeamDeliveryDependencyRecord['dependency_type'];
}

function toTeam(row: TeamRow): TeamRecord {
  return { ...row };
}

function toTeamMember(row: TeamMemberRow): TeamMemberRecord {
  return { ...row };
}

function toTeamRun(row: TeamRunRow): TeamRunRecord {
  return { ...row };
}

function toTeamMessage(row: TeamMessageRow): TeamMessageRecord {
  return { ...row };
}

function toTeamDelivery(row: TeamDeliveryRow): TeamMessageDeliveryRecord {
  return { ...row };
}

function toTeamDependency(row: TeamDependencyRow): TeamDeliveryDependencyRecord {
  return { ...row };
}
