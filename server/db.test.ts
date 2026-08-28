import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './db';
import type { SessionRecord } from '../shared/session';
import type { TeamMemberRecord, TeamRecord } from '../shared/team';

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    session_id: 'dashboard-session-1',
    coding_agent: 'fake',
    real_session_id: 'native-session-1',
    name: 'Session',
    cwd: '/project',
    status: 'completed',
    model: null,
    last_error: null,
    create_time: 1,
    modify_time: 1,
    ...overrides,
  };
}

function team(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    team_id: 'team-1',
    name: 'Product Builder',
    cwd: '/project',
    status: 'idle',
    max_parallel_members: 1,
    create_time: 10,
    modify_time: 10,
    ...overrides,
  };
}

function member(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
  return {
    member_id: 'member-1',
    team_id: 'team-1',
    role: 'leader',
    coding_agent: 'fake',
    session_id: 'dashboard-session-1',
    model: null,
    responsibility_prompt: 'Lead the team.',
    status: 'idle',
    current_delivery_id: null,
    initialized_at: null,
    file_access: 'read_write',
    execution_cwd: '/project',
    worktree_path: null,
    worktree_branch: null,
    create_time: 11,
    modify_time: 11,
    ...overrides,
  };
}

describe('SessionStore latest-error persistence', () => {
  it('migrates an existing session database without losing its metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-db-migration-'));
    temporaryDirs.push(dir);
    const path = join(dir, 'sessions.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE session (
        session_id TEXT PRIMARY KEY, coding_agent TEXT NOT NULL, real_session_id TEXT NOT NULL,
        name TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL,
        create_time INTEGER NOT NULL, modify_time INTEGER NOT NULL
      );
      INSERT INTO session VALUES ('old-1', 'claude', 'native-1', 'Imported', '/repo', 'completed', 10, 20);
    `);
    legacy.close();

    const db = new Database(path);
    try {
      const store = new SessionStore(db);
      expect(store.get('old-1')).toEqual({
        session_id: 'old-1',
        coding_agent: 'claude',
        real_session_id: 'native-1',
        name: 'Imported',
        cwd: '/repo',
        status: 'completed',
        model: null,
        last_error: null,
        create_time: 10,
        modify_time: 20,
      });
    } finally {
      db.close();
    }
  });

  it('records adapter failures and clears the latest error after a successful completion', () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      store.insert(session());

      store.recordError('dashboard-session-1', 'SDK disconnected');
      expect(store.get('dashboard-session-1')).toMatchObject({ status: 'error', last_error: 'SDK disconnected' });

      store.updateStatus('dashboard-session-1', 'completed');
      expect(store.get('dashboard-session-1')).toMatchObject({ status: 'completed', last_error: null });
    } finally {
      db.close();
    }
  });
});

describe('SessionStore agent team persistence', () => {
  it('migrates legacy team members with read-write compatibility defaults and execution cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-team-db-migration-'));
    temporaryDirs.push(dir);
    const path = join(dir, 'sessions.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE session (
        session_id TEXT PRIMARY KEY, coding_agent TEXT NOT NULL, real_session_id TEXT NOT NULL,
        name TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL, model TEXT, last_error TEXT,
        create_time INTEGER NOT NULL, modify_time INTEGER NOT NULL
      );
      CREATE TABLE team (
        team_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL,
        max_parallel_members INTEGER NOT NULL, create_time INTEGER NOT NULL, modify_time INTEGER NOT NULL
      );
      CREATE TABLE team_member (
        member_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, role TEXT NOT NULL,
        coding_agent TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, model TEXT,
        responsibility_prompt TEXT NOT NULL, status TEXT NOT NULL, current_delivery_id TEXT,
        initialized_at INTEGER, create_time INTEGER NOT NULL, modify_time INTEGER NOT NULL,
        UNIQUE(team_id, role)
      );

      INSERT INTO session VALUES ('dashboard-session-1', 'fake', 'native-session-1', 'Legacy member', '/legacy-project', 'completed', NULL, NULL, 1, 2);
      INSERT INTO team VALUES ('team-1', 'Legacy Team', '/legacy-project', 'idle', 1, 10, 20);
      INSERT INTO team_member VALUES ('member-1', 'team-1', 'leader', 'fake', 'dashboard-session-1', NULL, 'Lead legacy work.', 'idle', NULL, NULL, 11, 21);
    `);
    legacy.close();

    const db = new Database(path);
    try {
      const store = new SessionStore(db);
      expect(store.getTeam('team-1')?.members[0]).toMatchObject({
        member_id: 'member-1',
        file_access: 'read_write',
        execution_cwd: '/legacy-project',
        worktree_path: null,
        worktree_branch: null,
      });
    } finally {
      db.close();
    }
  });

  it('persists teams with members and enforces one team member per session', () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      store.insert(session());
      store.insert(session({ session_id: 'dashboard-session-2', real_session_id: 'native-session-2' }));

      store.insertTeam(team(), [
        member(),
        member({
          member_id: 'member-2',
          role: 'reviewer',
          session_id: 'dashboard-session-2',
          responsibility_prompt: 'Review the work.',
          model: 'fake/fast',
          create_time: 12,
          modify_time: 12,
        }),
      ]);

      expect(store.listTeams()).toEqual([
        {
          ...team(),
          members: [
            member(),
            member({
              member_id: 'member-2',
              role: 'reviewer',
              session_id: 'dashboard-session-2',
              responsibility_prompt: 'Review the work.',
              model: 'fake/fast',
              create_time: 12,
              modify_time: 12,
            }),
          ],
        },
      ]);
      expect(store.listVisibleSessions()).toEqual([]);

      expect(() =>
        store.insertTeam(team({ team_id: 'team-2' }), [
          member({ member_id: 'member-3', team_id: 'team-2', session_id: 'dashboard-session-1' }),
        ]),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('deletes a team with its member rows and dashboard session records', () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      store.insert(session());
      store.insert(session({ session_id: 'dashboard-session-2', real_session_id: 'native-session-2' }));
      store.insertTeam(team(), [
        member(),
        member({ member_id: 'member-2', role: 'tester', session_id: 'dashboard-session-2' }),
      ]);

      expect(store.deleteTeam('team-1')).toBe(true);

      expect(store.getTeam('team-1')).toBeUndefined();
      expect(store.get('dashboard-session-1')).toBeUndefined();
      expect(store.get('dashboard-session-2')).toBeUndefined();
      expect(store.listTeams()).toEqual([]);
      expect(store.listVisibleSessions()).toEqual([]);
      expect(store.deleteTeam('missing')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('marks team member session references as missing instead of failing team reads', () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      store.insert(session());
      store.insertTeam(team(), [member()]);

      store.delete('dashboard-session-1');

      expect(store.listTeams()).toEqual([
        {
          ...team(),
          members: [
            {
              ...member(),
              session_missing: true,
            },
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });
});
