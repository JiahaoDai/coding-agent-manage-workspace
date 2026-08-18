import { STATUS_LABEL } from '../labels';
import { groupByAgent } from '../sessionFilters';
import type { SessionRecord } from '../types';

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onDelete,
  emptyLabel = 'No sessions yet.',
}: {
  sessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
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
            <div
              key={session.session_id}
              className={`session-item${session.session_id === selectedId ? ' is-selected' : ''}`}
            >
              <button
                type="button"
                className="session-item-main"
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
              <button
                type="button"
                className="session-item-delete"
                onClick={() => onDelete(session.session_id)}
                aria-label={`Delete ${session.name}`}
                title="Delete session (native session is kept)"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
