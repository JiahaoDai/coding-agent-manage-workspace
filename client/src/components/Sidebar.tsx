import { useState } from 'react';
import { DEFAULT_FILTERS, filterSessions } from '../sessionFilters';
import type { SessionRecord } from '../types';
import { SessionFiltersBar } from './SessionFiltersBar';
import { SessionList } from './SessionList';

export function Sidebar({
  sessions,
  connected,
  selectedId,
  onSelect,
  onNewSession,
}: {
  sessions: SessionRecord[];
  connected: boolean;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
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

      <SessionFiltersBar sessions={sessions} filters={filters} onChange={setFilters} />
      <SessionList sessions={filtered} selectedId={selectedId} onSelect={onSelect} emptyLabel={emptyLabel} />

      <footer className="sidebar-footer" role="status">
        <span className={`conn-dot ${connected ? 'is-connected' : ''}`} aria-hidden="true" />
        <span className="conn-label">{connected ? 'Connected' : 'Reconnecting…'}</span>
      </footer>
    </aside>
  );
}
