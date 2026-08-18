import type { SessionRecord } from '../types';
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

      <SessionList sessions={sessions} selectedId={selectedId} onSelect={onSelect} />

      <footer className="sidebar-footer" role="status">
        <span className={`conn-dot ${connected ? 'is-connected' : ''}`} aria-hidden="true" />
        <span className="conn-label">{connected ? 'Connected' : 'Reconnecting…'}</span>
      </footer>
    </aside>
  );
}
