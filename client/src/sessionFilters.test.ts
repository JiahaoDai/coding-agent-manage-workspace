import { describe, expect, it } from 'vitest';
import {
  agentOptions,
  DEFAULT_FILTERS,
  filterSessions,
  groupByAgent,
  statusOptions,
} from './sessionFilters';
import type { SessionFilters } from './sessionFilters';
import type { SessionRecord } from './types';

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    session_id: 'id',
    coding_agent: 'claude',
    real_session_id: 'real',
    name: 'Name',
    cwd: '/tmp/name',
    status: 'completed',
    create_time: 0,
    modify_time: 0,
    ...overrides,
  };
}

const all = [
  session({ session_id: '1', coding_agent: 'claude', name: 'Fix login', cwd: '/repo/web', status: 'running' }),
  session({ session_id: '2', coding_agent: 'claude', name: 'Refactor api', cwd: '/repo/api', status: 'completed' }),
  session({ session_id: '3', coding_agent: 'opencode', name: 'Write tests', cwd: '/repo/web/tests', status: 'error' }),
];

describe('filterSessions', () => {
  it('returns everything when no filter is set', () => {
    expect(filterSessions(all, DEFAULT_FILTERS)).toEqual(all);
  });

  it('matches the keyword against the name, case-insensitively', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, query: 'FIX' })).toEqual([all[0]]);
  });

  it('matches the keyword against the cwd', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, query: 'api' })).toEqual([all[1]]);
  });

  it('matches keyword on directory even when name differs', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, query: 'tests' })).toEqual([all[2]]);
  });

  it('returns nothing when no session matches the keyword', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, query: 'zzz' })).toEqual([]);
  });

  it('filters by agent', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, agent: 'opencode' })).toEqual([all[2]]);
  });

  it('filters by status', () => {
    expect(filterSessions(all, { ...DEFAULT_FILTERS, status: 'completed' })).toEqual([all[1]]);
  });

  it('combines agent, status and keyword', () => {
    const filters: SessionFilters = { ...DEFAULT_FILTERS, agent: 'claude', status: 'running', query: 'login' };
    expect(filterSessions(all, filters)).toEqual([all[0]]);
  });
});

describe('agentOptions', () => {
  it('returns distinct agents in first-appearance order', () => {
    expect(agentOptions(all)).toEqual(['claude', 'opencode']);
  });

  it('returns an empty list for no sessions', () => {
    expect(agentOptions([])).toEqual([]);
  });
});

describe('statusOptions', () => {
  it('returns the four statuses in display order', () => {
    expect(statusOptions()).toEqual(['running', 'completed', 'error', 'cancelled']);
  });
});

describe('groupByAgent', () => {
  it('groups sessions by agent, preserving first-appearance order', () => {
    const groups = groupByAgent(all);
    expect(groups).toHaveLength(2);
    expect(groups[0].agent).toBe('claude');
    expect(groups[0].sessions.map((s) => s.session_id)).toEqual(['1', '2']);
    expect(groups[1].agent).toBe('opencode');
    expect(groups[1].sessions.map((s) => s.session_id)).toEqual(['3']);
  });

  it('returns an empty list for no sessions', () => {
    expect(groupByAgent([])).toEqual([]);
  });
});
