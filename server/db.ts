import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../shared/session';
import type {
  TeamDeliveryAttemptRecord,
  TeamDeliveryAttemptStatus,
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
        initialized_at        INTEGER,
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
        error        TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        retry_after  INTEGER
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

      CREATE TABLE IF NOT EXISTS team_delivery_attempt (
        attempt_id     TEXT PRIMARY KEY,
        delivery_id    TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        status         TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        finished_at    INTEGER,
        output         TEXT,
        error          TEXT,
        UNIQUE(delivery_id, attempt_number)
      );

      CREATE INDEX IF NOT EXISTS idx_team_attempt_delivery
        ON team_delivery_attempt (delivery_id, attempt_number);
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
    const deliveryColumns = db.prepare(`PRAGMA table_info(team_message_delivery)`).all() as Array<{ name: string }>;
    if (!deliveryColumns.some((column) => column.name === 'max_attempts')) {
      db.exec(`ALTER TABLE team_message_delivery ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3`);
    }
    if (!deliveryColumns.some((column) => column.name === 'retry_after')) {
      db.exec(`ALTER TABLE team_message_delivery ADD COLUMN retry_after INTEGER`);
    }
    const attemptColumns = db.prepare(`PRAGMA table_info(team_delivery_attempt)`).all() as Array<{ name: string }>;
    if (!attemptColumns.some((column) => column.name === 'output')) {
      db.exec(`ALTER TABLE team_delivery_attempt ADD COLUMN output TEXT`);
    }
    const memberColumns = db.prepare(`PRAGMA table_info(team_member)`).all() as Array<{ name: string }>;
    if (!memberColumns.some((column) => column.name === 'initialized_at')) {
      db.exec(`ALTER TABLE team_member ADD COLUMN initialized_at INTEGER`);
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

  markTeamMemberInitialized(member_id: string, now: number = Date.now()): TeamMemberRecord | undefined {
    this.db
      .prepare(
        `UPDATE team_member
         SET initialized_at = COALESCE(initialized_at, ?), modify_time = ?
         WHERE member_id = ?`,
      )
      .run(now, now, member_id);
    return this.getTeamMember(member_id);
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
            status, current_delivery_id, initialized_at, create_time, modify_time)
         VALUES
           (@member_id, @team_id, @role, @coding_agent, @session_id, @model, @responsibility_prompt,
            @status, @current_delivery_id, @initialized_at, @create_time, @modify_time)`,
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
      this.db
        .prepare(
          `DELETE FROM team_delivery_attempt
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
        max_rounds: 8,
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
        enqueue_seq: this.nextMemberQueueSeq(input.leader_member_id),
        created_at: input.now,
        started_at: null,
        finished_at: null,
        error: null,
        max_attempts: 3,
        retry_after: null,
      };

      this.insertTeamRun(run);
      this.insertTeamMessage(message);
      this.insertTeamDelivery(delivery);
      this.updateTeamStatus(input.team_id, 'running');
      return { run, messages: [message], deliveries: [delivery], attempts: [], dependencies: [] };
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
        attempts: this.listTeamDeliveryAttempts(run.run_id),
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
      attempts: this.listTeamDeliveryAttempts(run_id),
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

  startTeamDeliveryAttempt(delivery_id: string): { delivery: TeamMessageDeliveryRecord; attempt: TeamDeliveryAttemptRecord } | undefined {
    const start = this.db.transaction(() => {
      const row = this.getTeamDeliveryRow(delivery_id);
      if (!row || row.status !== 'pending') return undefined;

      const now = Date.now();
      const attempt = this.createTeamDeliveryAttempt(delivery_id, now);
      this.db
        .prepare(
          `UPDATE team_message_delivery
           SET status = 'running',
               started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
               retry_after = NULL,
               error = NULL
           WHERE delivery_id = ? AND status = 'pending'`,
        )
        .run(now, delivery_id);

      return {
        delivery: toTeamDelivery({ ...row, status: 'running', started_at: row.started_at ?? now, error: null, retry_after: null }),
        attempt,
      };
    });

    return start();
  }

  finishTeamDeliveryAttempt(input: {
    delivery_id: string;
    attempt_id: string;
    status: Exclude<TeamDeliveryAttemptStatus, 'running'>;
    error: string | null;
    output?: string | null;
    retry_after?: number | null;
  }): { delivery: TeamMessageDeliveryRecord; attempt: TeamDeliveryAttemptRecord } | undefined {
    const finish = this.db.transaction(() => {
      const attemptRow = this.db
        .prepare(
          `SELECT attempt_id, delivery_id, attempt_number, status, started_at, finished_at, output, error
           FROM team_delivery_attempt
           WHERE attempt_id = ? AND delivery_id = ?`,
        )
        .get(input.attempt_id, input.delivery_id) as TeamDeliveryAttemptRow | undefined;
      const deliveryRow = this.getTeamDeliveryRow(input.delivery_id);
      if (!attemptRow || !deliveryRow) return undefined;

      const now = Date.now();
      this.db
        .prepare(
          `UPDATE team_delivery_attempt
           SET status = ?, finished_at = ?, output = ?, error = ?
           WHERE attempt_id = ?`,
        )
        .run(input.status, now, input.output ?? null, input.error, input.attempt_id);

      const deliveryStatus: TeamDeliveryStatus =
        input.status === 'failed' && input.retry_after !== undefined && input.retry_after !== null ? 'pending' : input.status;
      this.db
        .prepare(
          `UPDATE team_message_delivery
           SET status = ?,
               finished_at = CASE WHEN ? IN ('done', 'failed', 'cancelled') THEN ? ELSE NULL END,
               error = ?,
               retry_after = ?
           WHERE delivery_id = ?`,
        )
        .run(
          deliveryStatus,
          deliveryStatus,
          now,
          input.error,
          deliveryStatus === 'pending' ? input.retry_after ?? null : null,
          input.delivery_id,
        );

      return {
        delivery: toTeamDelivery({
          ...deliveryRow,
          status: deliveryStatus,
          finished_at: deliveryStatus === 'pending' ? null : now,
          error: input.error,
          retry_after: deliveryStatus === 'pending' ? input.retry_after ?? null : null,
        }),
        attempt: toTeamDeliveryAttempt({
          ...attemptRow,
          status: input.status,
          finished_at: now,
          output: input.output ?? null,
          error: input.error,
        }),
      };
    });

    return finish();
  }

  releaseSatisfiedBlockedDeliveries(run_id: string): TeamMessageDeliveryRecord[] {
    const release = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT delivery_id, message_id, team_id, run_id, to_member_id, status, enqueue_seq,
                  created_at, started_at, finished_at, error, max_attempts, retry_after
           FROM team_message_delivery delivery
           WHERE delivery.run_id = ?
             AND delivery.status = 'blocked'
             AND NOT EXISTS (
               SELECT 1
               FROM team_delivery_dependency dep
               JOIN team_message_delivery upstream
                 ON upstream.delivery_id = dep.depends_on_delivery_id
               WHERE dep.delivery_id = delivery.delivery_id
                 AND (
                   (dep.dependency_type = 'success' AND upstream.status != 'done')
                   OR (dep.dependency_type = 'finished' AND upstream.status NOT IN ('done', 'failed', 'cancelled'))
                 )
             )
           ORDER BY delivery.created_at ASC, delivery.enqueue_seq ASC, delivery.delivery_id ASC`,
        )
        .all(run_id) as TeamDeliveryRow[];
      if (rows.length === 0) return [];

      const update = this.db.prepare(`UPDATE team_message_delivery SET status = 'pending' WHERE delivery_id = ?`);
      for (const row of rows) update.run(row.delivery_id);
      return rows.map((row) => toTeamDelivery({ ...row, status: 'pending' }));
    });

    return release();
  }

  claimNextRunnableTeamDelivery(run_id: string): {
    delivery: TeamMessageDeliveryRecord;
    attempt: TeamDeliveryAttemptRecord;
    message: TeamMessageRecord;
    member: TeamMemberRecord;
  } | undefined;
  claimNextRunnableTeamDelivery(
    run_id: string,
    options: { includeLeader: false },
  ): {
    delivery: TeamMessageDeliveryRecord;
    attempt: TeamDeliveryAttemptRecord;
    message: TeamMessageRecord;
    member: TeamMemberRecord;
  } | undefined;
  claimNextRunnableTeamDelivery(
    run_id: string,
    options: { includeLeader: boolean } = { includeLeader: true },
  ): {
    delivery: TeamMessageDeliveryRecord;
    attempt: TeamDeliveryAttemptRecord;
    message: TeamMessageRecord;
    member: TeamMemberRecord;
  } | undefined {
    const claim = this.db.transaction(() => {
      const running = this.db
        .prepare(
          `SELECT 1
           FROM team_message_delivery
           WHERE run_id = ? AND status = 'running'
           LIMIT 1`,
        )
        .get(run_id);
      if (running) return undefined;

      const row = this.db
        .prepare(
          `SELECT delivery.delivery_id, delivery.message_id, delivery.team_id, delivery.run_id,
                  delivery.to_member_id, delivery.status, delivery.enqueue_seq, delivery.created_at,
                  delivery.started_at, delivery.finished_at, delivery.error, delivery.max_attempts, delivery.retry_after
           FROM team_message_delivery delivery
           JOIN team_member member ON member.member_id = delivery.to_member_id
           WHERE delivery.run_id = ?
             AND delivery.status = 'pending'
             AND (delivery.retry_after IS NULL OR delivery.retry_after <= ?)
             AND member.status = 'idle'
             AND (? = 1 OR member.role != 'leader')
             AND NOT EXISTS (
               SELECT 1
               FROM team_delivery_dependency dep
               JOIN team_message_delivery upstream
                 ON upstream.delivery_id = dep.depends_on_delivery_id
               WHERE dep.delivery_id = delivery.delivery_id
                 AND (
                   (dep.dependency_type = 'success' AND upstream.status != 'done')
                   OR (dep.dependency_type = 'finished' AND upstream.status NOT IN ('done', 'failed', 'cancelled'))
                 )
             )
           ORDER BY delivery.created_at ASC, delivery.enqueue_seq ASC, delivery.delivery_id ASC
           LIMIT 1`,
        )
        .get(run_id, Date.now(), options.includeLeader ? 1 : 0) as TeamDeliveryRow | undefined;
      if (!row) return undefined;

      const now = Date.now();
      const attempt = this.createTeamDeliveryAttempt(row.delivery_id, now);
      this.db
        .prepare(
          `UPDATE team_message_delivery
           SET status = 'running',
               started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
               retry_after = NULL,
               error = NULL
           WHERE delivery_id = ? AND status = 'pending'`,
        )
        .run(now, row.delivery_id);
      this.db
        .prepare(`UPDATE team_member SET status = 'running', current_delivery_id = ?, modify_time = ? WHERE member_id = ?`)
        .run(row.delivery_id, now, row.to_member_id);

      return {
        delivery: toTeamDelivery({ ...row, status: 'running', started_at: row.started_at ?? now, error: null, retry_after: null }),
        attempt,
        message: this.getTeamMessage(row.message_id)!,
        member: this.getTeamMember(row.to_member_id)!,
      };
    });

    return claim();
  }

  hasActiveNonLeaderTeamDeliveries(run_id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM team_message_delivery delivery
         JOIN team_member member ON member.member_id = delivery.to_member_id
         WHERE delivery.run_id = ?
           AND member.role != 'leader'
           AND delivery.status IN ('pending', 'running')
         LIMIT 1`,
      )
      .get(run_id);
    return Boolean(row);
  }

  getTeamMember(member_id: string): TeamMemberRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT member_id, team_id, role, coding_agent, session_id, model, responsibility_prompt,
                status, current_delivery_id, initialized_at, create_time, modify_time
         FROM team_member WHERE member_id = ?`,
      )
      .get(member_id) as TeamMemberRow | undefined;
    return row ? toTeamMember(row) : undefined;
  }

  getTeamMessage(message_id: string): TeamMessageRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT message_id, team_id, run_id, from_member_id, from_kind, kind, content, create_time
         FROM team_message WHERE message_id = ?`,
      )
      .get(message_id) as TeamMessageRow | undefined;
    return row ? toTeamMessage(row) : undefined;
  }

  listDeliveryDependencies(delivery_id: string): TeamDeliveryDependencyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT delivery_id, depends_on_delivery_id, dependency_type
         FROM team_delivery_dependency
         WHERE delivery_id = ?
         ORDER BY depends_on_delivery_id ASC`,
      )
      .all(delivery_id) as TeamDependencyRow[];
    return rows.map(toTeamDependency);
  }

  completeRunIfNoOpenDeliveries(run_id: string): TeamRunRecord | undefined {
    const complete = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time
           FROM team_run WHERE run_id = ?`,
        )
        .get(run_id) as TeamRunRow | undefined;
      if (!row || row.status !== 'running') return undefined;

      const open = this.db
        .prepare(
          `SELECT 1
           FROM team_message_delivery
           WHERE run_id = ? AND status IN ('blocked', 'pending', 'running')
           LIMIT 1`,
        )
        .get(run_id);
      if (open) return undefined;

      const failed = this.db
        .prepare(
          `SELECT 1
           FROM team_message_delivery
           WHERE run_id = ? AND status = 'failed'
           LIMIT 1`,
        )
        .get(run_id);
      const status: TeamRunStatus = failed ? 'failed' : 'completed';
      const teamStatus: TeamStatus = failed ? 'error' : 'idle';
      const now = Date.now();
      this.db.prepare(`UPDATE team_run SET status = ?, finish_time = ? WHERE run_id = ?`).run(status, now, run_id);
      this.db.prepare(`UPDATE team SET status = ?, modify_time = ? WHERE team_id = ?`).run(teamStatus, now, row.team_id);
      return toTeamRun({ ...row, status, finish_time: now });
    });

    return complete();
  }

  cancelOpenTeamDeliveries(run_id: string, except_delivery_id: string | null = null): TeamMessageDeliveryRecord[] {
    const cancel = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT delivery_id, message_id, team_id, run_id, to_member_id, status, enqueue_seq,
                  created_at, started_at, finished_at, error, max_attempts, retry_after
           FROM team_message_delivery
           WHERE run_id = ?
             AND status IN ('blocked', 'pending')
             AND (? IS NULL OR delivery_id != ?)
           ORDER BY created_at ASC, enqueue_seq ASC, delivery_id ASC`,
        )
        .all(run_id, except_delivery_id, except_delivery_id) as TeamDeliveryRow[];
      if (rows.length === 0) return [];

      const now = Date.now();
      const update = this.db.prepare(
        `UPDATE team_message_delivery
         SET status = 'cancelled', finished_at = ?, retry_after = NULL
         WHERE delivery_id = ?`,
      );
      for (const row of rows) update.run(now, row.delivery_id);
      const cancelAttempt = this.db.prepare(
        `UPDATE team_delivery_attempt
         SET status = 'cancelled', finished_at = ?
         WHERE delivery_id = ? AND status = 'running'`,
      );
      for (const row of rows) cancelAttempt.run(now, row.delivery_id);
      return rows.map((row) => toTeamDelivery({ ...row, status: 'cancelled', finished_at: now, retry_after: null }));
    });

    return cancel();
  }

  advanceTeamRunRound(run_id: string): { run: TeamRunRecord } | { error: string; run: TeamRunRecord } | undefined {
    const advance = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time
           FROM team_run WHERE run_id = ?`,
        )
        .get(run_id) as TeamRunRow | undefined;
      if (!row) return undefined;
      const run = toTeamRun(row);
      if (run.status !== 'running') return { run };
      if (run.current_round >= run.max_rounds) {
        return { error: `team run exceeded max_rounds (${run.max_rounds})`, run };
      }

      const nextRound = run.current_round + 1;
      this.db.prepare(`UPDATE team_run SET current_round = ? WHERE run_id = ?`).run(nextRound, run_id);
      return { run: { ...run, current_round: nextRound } };
    });

    return advance();
  }

  finishTeamRun(run_id: string, status: TeamRunStatus): TeamRunRecord {
    this.db
      .prepare(`UPDATE team_run SET status = ?, finish_time = ? WHERE run_id = ?`)
      .run(status, Date.now(), run_id);
    return this.getTeamRun(run_id)!.run;
  }

  waitTeamRunForUser(input: {
    team_id: string;
    run_id: string;
    leader_member_id: string;
    delivery_id: string;
    question_message_id: string;
    question: string;
    now: number;
  }): { run: TeamRunRecord; question_message: TeamMessageRecord; delivery: TeamMessageDeliveryRecord } {
    const wait = this.db.transaction(() => {
      const question_message: TeamMessageRecord = {
        message_id: input.question_message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        from_member_id: input.leader_member_id,
        from_kind: 'member',
        kind: 'need_info',
        content: input.question,
        create_time: input.now,
      };

      this.insertTeamMessage(question_message);
      this.db
        .prepare(
          `UPDATE team_message_delivery
           SET status = 'done',
               finished_at = ?
           WHERE delivery_id = ?`,
        )
        .run(input.now, input.delivery_id);
      this.db
        .prepare(`UPDATE team_member SET status = 'idle', current_delivery_id = NULL, modify_time = ? WHERE member_id = ?`)
        .run(input.now, input.leader_member_id);
      this.db.prepare(`UPDATE team_run SET status = 'waiting_user', finish_time = NULL WHERE run_id = ?`).run(input.run_id);
      this.db.prepare(`UPDATE team SET status = 'waiting_user', modify_time = ? WHERE team_id = ?`).run(input.now, input.team_id);

      const run = this.getTeamRun(input.run_id)!.run;
      const delivery = this.listTeamDeliveries(input.run_id).find((item) => item.delivery_id === input.delivery_id)!;
      return { run, question_message, delivery };
    });

    return wait();
  }

  resumeWaitingTeamRun(input: {
    team_id: string;
    leader_member_id: string;
    user_message_id: string;
    delivery_id: string;
    content: string;
    now: number;
  }): TeamRunWithItems | undefined {
    const resume = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT run_id, team_id, root_user_message_id, status, max_rounds, current_round, create_time, finish_time
           FROM team_run
           WHERE team_id = ? AND status = 'waiting_user'
           ORDER BY create_time DESC
           LIMIT 1`,
        )
        .get(input.team_id) as TeamRunRow | undefined;
      if (!row) return undefined;
      const run = toTeamRun(row);

      const message: TeamMessageRecord = {
        message_id: input.user_message_id,
        team_id: input.team_id,
        run_id: run.run_id,
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
        run_id: run.run_id,
        to_member_id: input.leader_member_id,
        status: 'pending',
        enqueue_seq: this.nextMemberQueueSeq(input.leader_member_id),
        created_at: input.now,
        started_at: null,
        finished_at: null,
        error: null,
        max_attempts: 3,
        retry_after: null,
      };

      this.insertTeamMessage(message);
      this.insertTeamDelivery(delivery);
      this.db.prepare(`UPDATE team_run SET status = 'running', finish_time = NULL WHERE run_id = ?`).run(run.run_id);
      this.db.prepare(`UPDATE team SET status = 'running', modify_time = ? WHERE team_id = ?`).run(input.now, input.team_id);

      return this.getTeamRun(run.run_id)!;
    });

    return resume();
  }

  insertTeamMessageRecord(message: TeamMessageRecord): void {
    this.insertTeamMessage(message);
  }

  createMemberOutboundRoute(input: {
    team_id: string;
    run_id: string;
    from_member_id: string;
    leader_member_id: string;
    message_id: string;
    delivery_id: string;
    kind: TeamMessageRecord['kind'];
    content: string;
    now: number;
  }): { message: TeamMessageRecord; delivery: TeamMessageDeliveryRecord } {
    const create = this.db.transaction(() => {
      const message: TeamMessageRecord = {
        message_id: input.message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        from_member_id: input.from_member_id,
        from_kind: 'member',
        kind: input.kind,
        content: input.content,
        create_time: input.now,
      };
      const delivery: TeamMessageDeliveryRecord = {
        delivery_id: input.delivery_id,
        message_id: input.message_id,
        team_id: input.team_id,
        run_id: input.run_id,
        to_member_id: input.leader_member_id,
        status: 'pending',
        enqueue_seq: this.nextMemberQueueSeq(input.leader_member_id),
        created_at: input.now,
        started_at: null,
        finished_at: null,
        error: null,
        max_attempts: 3,
        retry_after: null,
      };

      this.insertTeamMessage(message);
      this.insertTeamDelivery(delivery);
      return { message, delivery };
    });

    return create();
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
          max_attempts: 3,
          retry_after: null,
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
        `SELECT member.member_id, member.team_id, member.role, member.coding_agent, member.session_id,
                member.model, member.responsibility_prompt, member.status, member.current_delivery_id,
                member.initialized_at,
                member.create_time, member.modify_time,
                CASE WHEN session.session_id IS NULL THEN 1 ELSE 0 END AS session_missing
         FROM team_member member
         LEFT JOIN session ON session.session_id = member.session_id
         WHERE member.team_id = ?
         ORDER BY member.create_time ASC`,
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
            created_at, started_at, finished_at, error, max_attempts, retry_after)
         VALUES
           (@delivery_id, @message_id, @team_id, @run_id, @to_member_id, @status, @enqueue_seq,
            @created_at, @started_at, @finished_at, @error, @max_attempts, @retry_after)`,
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

  private createTeamDeliveryAttempt(delivery_id: string, now: number): TeamDeliveryAttemptRecord {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
         FROM team_delivery_attempt
         WHERE delivery_id = ?`,
      )
      .get(delivery_id) as { attempt_number: number };
    const attempt: TeamDeliveryAttemptRecord = {
      attempt_id: randomUUID(),
      delivery_id,
      attempt_number: row.attempt_number,
      status: 'running',
      started_at: now,
      finished_at: null,
      output: null,
      error: null,
    };
    this.db
      .prepare(
        `INSERT INTO team_delivery_attempt
           (attempt_id, delivery_id, attempt_number, status, started_at, finished_at, output, error)
         VALUES
           (@attempt_id, @delivery_id, @attempt_number, @status, @started_at, @finished_at, @output, @error)`,
      )
      .run(attempt);
    return attempt;
  }

  private getTeamDeliveryRow(delivery_id: string): TeamDeliveryRow | undefined {
    return this.db
      .prepare(
        `SELECT delivery_id, message_id, team_id, run_id, to_member_id, status, enqueue_seq,
                created_at, started_at, finished_at, error, max_attempts, retry_after
         FROM team_message_delivery WHERE delivery_id = ?`,
      )
      .get(delivery_id) as TeamDeliveryRow | undefined;
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
                created_at, started_at, finished_at, error, max_attempts, retry_after
         FROM team_message_delivery WHERE run_id = ? ORDER BY created_at ASC, enqueue_seq ASC, delivery_id ASC`,
      )
      .all(run_id) as TeamDeliveryRow[];
    return rows.map(toTeamDelivery);
  }

  private listTeamDeliveryAttempts(run_id: string): TeamDeliveryAttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT attempt.attempt_id, attempt.delivery_id, attempt.attempt_number, attempt.status,
                attempt.started_at, attempt.finished_at, attempt.output, attempt.error
         FROM team_delivery_attempt attempt
         JOIN team_message_delivery delivery ON delivery.delivery_id = attempt.delivery_id
         WHERE delivery.run_id = ?
         ORDER BY delivery.created_at ASC, attempt.attempt_number ASC`,
      )
      .all(run_id) as TeamDeliveryAttemptRow[];
    return rows.map(toTeamDeliveryAttempt);
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
  initialized_at: number | null;
  session_missing?: 0 | 1;
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
  max_attempts: number;
  retry_after: number | null;
}

interface TeamDeliveryAttemptRow {
  attempt_id: string;
  delivery_id: string;
  attempt_number: number;
  status: TeamDeliveryAttemptRecord['status'];
  started_at: number;
  finished_at: number | null;
  output: string | null;
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
  const { session_missing, ...member } = row;
  return session_missing === 1 ? { ...member, session_missing: true } : member;
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

function toTeamDeliveryAttempt(row: TeamDeliveryAttemptRow): TeamDeliveryAttemptRecord {
  return { ...row };
}

function toTeamDependency(row: TeamDependencyRow): TeamDeliveryDependencyRecord {
  return { ...row };
}
