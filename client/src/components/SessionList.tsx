import { STATUS_LABEL } from '../labels';
import { groupByAgent } from '../sessionFilters';
import type { SessionRecord } from '../types';

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  emptyLabel = 'No sessions yet.',
}: {
  sessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Shown when there are no sessions to display (empty list, or none match filters). */
  emptyLabel?: string;
}) {
  if (sessions.length === 0) {
    return <p className="session-empty">{emptyLabel}</p>;
  }

  return (
    <nav className="session-list" aria-label="Sessions">
      {groupByAgent(sessions).map((group) => (
        <div key={group.agent} className="session-group">
          <h3 className="session-group-title">{group.agent}</h3>
          {group.sessions.map((session) => (
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
                <span className="session-item-cwd" title={session.cwd}>
                  {session.cwd}
                </span>
              </div>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
