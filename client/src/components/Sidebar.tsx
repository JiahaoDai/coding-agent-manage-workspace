import { useState } from 'react';
import { DEFAULT_FILTERS, filterSessions } from '../sessionFilters';
import type { SessionRecord, TeamWithMembers } from '../types';
import { SessionFiltersBar } from './SessionFiltersBar';
import { SessionList } from './SessionList';
import { TeamList } from './TeamList';

export function Sidebar({
  sessions,
  teams,
  connected,
  selectedId,
  selectedTeamId,
  onSelect,
  onSelectTeam,
  onOpenInSplit,
  onDelete,
  onDeleteTeam,
  onNewSession,
  onNewTeam,
  onToggle,
}: {
  sessions: SessionRecord[];
  teams: TeamWithMembers[];
  connected: boolean;
  selectedId: string | null;
  selectedTeamId: string | null;
  onSelect: (sessionId: string) => void;
  onSelectTeam: (teamId: string) => void;
  onOpenInSplit: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onDeleteTeam: (teamId: string) => void;
  onNewSession: () => void;
  onNewTeam: () => void;
  onToggle: () => void;
}) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const filtered = filterSessions(sessions, filters);
  // Different empty message depending on whether there are sessions at all.
  const emptyLabel =
    sessions.length > 0 && filtered.length === 0
      ? 'No sessions match your filters.'
      : 'No sessions yet.';

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="icon-btn sidebar-toggle" onClick={onToggle} aria-label="Hide sidebar" title="Hide sidebar">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 5h18" />
            <path d="M3 19h18" />
            <path d="M9 5v14" />
            <path d="m15 9-3 3 3 3" />
          </svg>
        </button>
        <span className="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
          </svg>
        </span>
        <span className="app-name">Coding Agent</span>
      </div>

      <button type="button" className="new-session-btn" onClick={onNewSession}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New session
      </button>
      <button type="button" className="new-session-btn" onClick={onNewTeam}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        New team
      </button>

      <TeamList
        teams={teams}
        selectedId={selectedTeamId}
        onSelect={onSelectTeam}
        onDelete={onDeleteTeam}
      />

      <SessionFiltersBar sessions={sessions} filters={filters} onChange={setFilters} />
      <SessionList
        sessions={filtered}
        selectedId={selectedId}
        onSelect={onSelect}
        onOpenInSplit={onOpenInSplit}
        onDelete={onDelete}
        emptyLabel={emptyLabel}
      />

      <footer className="sidebar-footer" role="status">
        <span className={`conn-dot ${connected ? 'is-connected' : ''}`} aria-hidden="true" />
        <span className="conn-label">{connected ? 'Connected' : 'Reconnecting…'}</span>
      </footer>
    </aside>
  );
}
