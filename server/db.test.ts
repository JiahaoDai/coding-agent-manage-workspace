import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './db';
import type { SessionRecord } from '../shared/session';

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
    last_error: null,
    create_time: 1,
    modify_time: 1,
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
