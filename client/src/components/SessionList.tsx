import { useEffect, useState, type MouseEvent } from 'react';
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
  onOpenInSplit,
  onDelete,
  emptyLabel = 'No sessions yet.',
}: {
  sessions: SessionRecord[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onOpenInSplit: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  /** Shown when there are no sessions to display (empty list, or none match filters). */
  emptyLabel?: string;
}) {
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;

    function close() {
      setMenu(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  function openContextMenu(event: MouseEvent, sessionId: string) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 168;
    const menuHeight = 88;
    const margin = 8;
    const maxX = window.innerWidth - menuWidth - margin;
    const maxY = window.innerHeight - menuHeight - margin;
    setMenu({
      sessionId,
      x: Math.max(margin, Math.min(event.clientX, maxX)),
      y: Math.max(margin, Math.min(event.clientY, maxY)),
    });
  }

  function choose(action: 'open' | 'split') {
    if (!menu) return;
    const sessionId = menu.sessionId;
    setMenu(null);
    if (action === 'open') {
      onSelect(sessionId);
    } else {
      onOpenInSplit(sessionId);
    }
  }

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
              onContextMenu={(event) => openContextMenu(event, session.session_id)}
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
      {menu && (
        <div
          className="session-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label="Session actions"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => choose('open')}>
            Open
          </button>
          <button type="button" role="menuitem" onClick={() => choose('split')}>
            Open in Split
          </button>
        </div>
      )}
    </nav>
  );
}
