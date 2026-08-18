import { STATUS_LABEL } from '../labels';
import type { SessionRecord } from '../types';

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  if (sessions.length === 0) {
    return <p className="session-empty">No sessions yet.</p>;
  }

  return (
    <nav className="session-list" aria-label="Sessions">
      {sessions.map((session) => (
        <button
          key={session.session_id}
          type="button"
          className={`session-item${session.session_id === selectedId ? ' is-selected' : ''}`}
          onClick={() => onSelect(session.session_id)}
          aria-current={session.session_id === selectedId ? 'true' : undefined}
        >
          <div className="session-item-head">
            <span className="session-item-name" title={session.name}>
              {session.name}
            </span>
            <span className={`status status-${session.status}`}>
              <span className="status-dot" aria-hidden="true" />
              {STATUS_LABEL[session.status]}
            </span>
          </div>
          <div className="session-item-sub">
            <span className="session-item-agent">{session.coding_agent}</span>
            <span className="session-item-cwd" title={session.cwd}>
              {session.cwd}
            </span>
          </div>
        </button>
      ))}
    </nav>
  );
}
