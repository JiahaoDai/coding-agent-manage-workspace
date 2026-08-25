import { STATUS_LABEL } from './labels';
import type { SessionRecord, SessionStatus } from './types';

/** What the sidebar filters the session list by. An empty value means "no filter". */
export interface SessionFilters {
  /** Free-text keyword matched (case-insensitive) against name and cwd. */
  query: string;
  /** coding_agent to keep, or '' for all. */
  agent: string;
  /** status to keep, or '' for all. */
  status: SessionStatus | '';
}

export const DEFAULT_FILTERS: SessionFilters = { query: '', agent: '', status: '' };

const normalize = (s: string) => s.trim().toLowerCase();

/** Keep only sessions matching the keyword (name or cwd), agent and status. */
export function filterSessions(
  sessions: SessionRecord[],
  filters: SessionFilters,
): SessionRecord[] {
  const query = normalize(filters.query);
  return sessions.filter((s) => {
    if (filters.agent && s.coding_agent !== filters.agent) return false;
    if (filters.status && s.status !== filters.status) return false;
    if (query) {
      const hits = normalize(s.name).includes(query) || normalize(s.cwd).includes(query);
      if (!hits) return false;
    }
    return true;
  });
}

/** Distinct coding_agents present, in first-appearance order. */
export function agentOptions(sessions: SessionRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sessions) {
    if (!seen.has(s.coding_agent)) {
      seen.add(s.coding_agent);
      out.push(s.coding_agent);
    }
  }
  return out;
}

/** The four statuses in display order (STATUS_LABEL's key order). */
export function statusOptions(): SessionStatus[] {
  return Object.keys(STATUS_LABEL) as SessionStatus[];
}

/** One group per coding_agent, preserving first-appearance order. */
export interface AgentGroup {
  agent: string;
  sessions: SessionRecord[];
}

export function groupByAgent(sessions: SessionRecord[]): AgentGroup[] {
  const groups: AgentGroup[] = [];
  const index = new Map<string, number>();
  for (const s of sessions) {
    let i = index.get(s.coding_agent);
    if (i === undefined) {
      i = groups.length;
      index.set(s.coding_agent, i);
      groups.push({ agent: s.coding_agent, sessions: [] });
    }
    groups[i].sessions.push(s);
  }
  return groups;
}
