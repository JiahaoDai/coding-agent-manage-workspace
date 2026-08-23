import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { deleteSession, getSessionMessages, getSessionModels, listAgents, listSessions, respondPermission, selectSessionModel, sendMessage } from './api';
import { ConversationView } from './components/ConversationView';
import { CreateSessionForm } from './components/CreateSessionForm';
import { EmptyState } from './components/EmptyState';
import { PermissionModal } from './components/PermissionModal';
import { Sidebar } from './components/Sidebar';
import {
  applyStreamEvent,
  applyUserMessage,
  messagesToConversation,
  isDisplayableStreamEvent,
  toStreamEvent,
  type ConversationMessage,
  type StreamableServerEvent,
} from './conversation';
import type { AgentId, ModelOption, PermissionRequest, ServerEvent, SessionRecord } from './types';
import {
  closePane,
  emptyWorkspace,
  openInActivePane,
  openInSplitPane,
  removeSessionFromWorkspace,
  restoreWorkspace,
  serializeWorkspace,
  setActivePane,
  setSplitRatio,
  type PaneId,
  type WorkspaceState,
} from './workspace';

const WORKSPACE_STORAGE_KEY = 'coding-agent-dashboard.workspace.v1';
const SIDEBAR_STORAGE_KEY = 'coding-agent-dashboard.sidebar-collapsed.v1';

/** Prepend only if the session is not already present — both the POST response
 * and the SSE `session_created` event may deliver the same session. */
function addSessionIfAbsent(prev: SessionRecord[], session: SessionRecord): SessionRecord[] {
  return prev.some((s) => s.session_id === session.session_id) ? prev : [session, ...prev];
}


export function App() {
  const [agents, setAgents] = useState<AgentId[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    typeof window === 'undefined' ? false : window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true',
  );
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace);
  const [conversations, setConversations] = useState<Record<string, ConversationMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Starts on normal prompt submission and ends at the first visible stream
  // event. This is deliberately separate from history: old assistant messages
  // must not suppress the pending feedback for a new turn.
  const [awaitingFirstResponse, setAwaitingFirstResponse] = useState<Record<string, boolean>>({});
  // Outstanding permission requests, oldest first, across all sessions. The
  // modal shows the first; the rest queue behind it.
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  // Per-session status of the initial history fetch. Requested once per session
  // per mount (ref), so re-selecting an already-loaded session doesn't refetch,
  // while a failed fetch can be retried on the next select.
  const requestedHistory = useRef<Set<string>>(new Set());
  const [historyStatus, setHistoryStatus] = useState<Record<string, { loading: boolean; error?: string }>>({});
  const [models, setModels] = useState<Record<string, { options: ModelOption[]; available: boolean }>>({});
  const workspaceRef = useRef<HTMLDivElement>(null);

  /**
   * A request id is only unique within a session (agents reuse per-turn
   * counters), so every queue operation is scoped by session + request id. A
   * response for one session must never drop or dedupe another session's
   * colliding request.
   */
  const sameRequest = (a: { session_id: string; request_id: string }, b: { session_id: string; request_id: string }) =>
    a.session_id === b.session_id && a.request_id === b.request_id;

  useEffect(() => {
    void listAgents().then(setAgents);
    void listSessions().then((list) => {
      setSessions(list);
      setWorkspace(restoreWorkspace(typeof window === 'undefined' ? null : window.localStorage.getItem(WORKSPACE_STORAGE_KEY), new Set(list.map((session) => session.session_id))));
      setSessionsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!sessionsLoaded || typeof window === 'undefined') return;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspace(workspace));
  }, [sessionsLoaded, workspace]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!sessionsLoaded) return;
    setWorkspace((prev) => restoreWorkspace(serializeWorkspace(prev), new Set(sessions.map((session) => session.session_id))));
  }, [sessions, sessionsLoaded]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setConnected(true);
      // EventSource auto-reconnects after a drop; re-read SQLite (the single
      // source of truth) so statuses missed during the gap are reconciled.
      void listSessions().then(setSessions);
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      switch (event.type) {
        case 'session_created':
          setSessions((prev) => addSessionIfAbsent(prev, event.session));
          break;
        case 'status_change':
          setSessions((prev) =>
            prev.map((s) => (s.session_id === event.session_id ? { ...s, status: event.status } : s)),
          );
          if (event.status !== 'running') {
            setAwaitingFirstResponse((prev) => ({ ...prev, [event.session_id]: false }));
          }
          break;
        case 'session_removed':
          removeSession(event.session_id);
          break;
        case 'text_delta':
        case 'thinking_delta':
        case 'tool_call_start':
        case 'tool_call_end':
        case 'status_note':
        case 'error': {
          const sid = event.session_id;
          if (sid) {
            const streamEvent = toStreamEvent(event as StreamableServerEvent);
            if (isDisplayableStreamEvent(streamEvent)) {
              setAwaitingFirstResponse((prev) => ({ ...prev, [sid]: false }));
            }
            setConversations((prev) => ({
              ...prev,
              [sid]: applyStreamEvent(prev[sid] ?? [], streamEvent),
            }));
          }
          break;
        }
        case 'permission_request':
          setAwaitingFirstResponse((prev) => ({ ...prev, [event.session_id]: false }));
          setPermissionQueue((prev) =>
            prev.some((p) => sameRequest(p, event))
              ? prev
              : [...prev, { session_id: event.session_id, request_id: event.request_id, tool_name: event.tool_name, input: event.input }],
          );
          break;
        case 'permission_response':
          // The request is resolved (by this tab or another); drop it so the
          // modal doesn't linger. Scoped to the same session: another session's
          // request that happens to share the id must stay queued. Filtering is
          // idempotent for the tab that just answered optimistically.
          setPermissionQueue((prev) => prev.filter((p) => !sameRequest(p, event)));
          break;
      }
    };
    return () => source.close();
  }, []);

  const openSessionIds = workspace.panels.map((panel) => panel.sessionId).join('|');

  // Load each visible session's history from its native store.
  // Message bodies live in the agent's store, never in SQLite (design §4), so
  // after a refresh the view starts empty and this repopulates it. The guard
  // keeps it once-per-session; live streamed turns still append on top.
  useEffect(() => {
    for (const id of workspace.panels.map((panel) => panel.sessionId)) {
      if (requestedHistory.current.has(id)) continue;
      requestedHistory.current.add(id);
      setHistoryStatus((prev) => ({ ...prev, [id]: { loading: true } }));
      getSessionMessages(id)
        .then((messages) => {
          setConversations((prev) =>
            // Never clobber a live conversation (a message just sent, or a turn
            // streaming in); only fill the empty view.
            prev[id] && prev[id].length > 0
              ? prev
              : messages.length
                ? { ...prev, [id]: messagesToConversation(messages) }
                : prev,
          );
          setHistoryStatus((prev) => ({ ...prev, [id]: { loading: false } }));
        })
        .catch((err) => {
          // Allow a retry on the next open.
          requestedHistory.current.delete(id);
          setHistoryStatus((prev) => ({
            ...prev,
            [id]: { loading: false, error: err instanceof Error ? err.message : String(err) },
          }));
        });
    }
  }, [openSessionIds, workspace.panels]);

  useEffect(() => {
    for (const id of workspace.panels.map((panel) => panel.sessionId)) {
      if (models[id]) continue;
      void getSessionModels(id)
        .then((result) => setModels((prev) => ({ ...prev, [id]: result.supported ? { options: result.value, available: true } : { options: [], available: false } })))
        .catch(() => setModels((prev) => ({ ...prev, [id]: { options: [], available: false } })));
    }
  }, [openSessionIds, workspace.panels, models]);

  async function handleSend(session: SessionRecord, text: string, model: string | null) {
    const id = session.session_id;
    if (model !== session.model) {
      try {
        const updated = await selectSessionModel(id, model);
        setSessions((prev) => prev.map((item) => item.session_id === id ? updated : item));
        session = updated;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setConversations((prev) => ({ ...prev, [id]: applyStreamEvent(prev[id] ?? [], { type: 'error', message: `Model selection failed: ${detail}` }) }));
        return;
      }
    }
    setConversations((prev) => ({ ...prev, [id]: applyUserMessage(prev[id] ?? [], text) }));
    setAwaitingFirstResponse((prev) => ({ ...prev, [id]: true }));
    try {
      await sendMessage(id, text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setConversations((prev) => ({
        ...prev,
        [id]: applyStreamEvent(prev[id] ?? [], { type: 'error', message: detail }),
      }));
      setAwaitingFirstResponse((prev) => ({ ...prev, [id]: false }));
    }
  }

  /** Drop a session everywhere: the list, its conversation, and the selection. */
  function removeSession(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    setWorkspace((prev) => removeSessionFromWorkspace(prev, sessionId));
    setConversations((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setAwaitingFirstResponse((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  async function handleDelete(sessionId: string) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setConversations((prev) => ({
        ...prev,
        [sessionId]: applyStreamEvent(prev[sessionId] ?? [], {
          type: 'error',
          message: `Delete failed: ${detail}`,
        }),
      }));
      return;
    }
    // The SSE `session_removed` also arrives and calls removeSession; doing it
    // here too keeps the UI instant and idempotent.
    removeSession(sessionId);
  }

  async function handlePermissionDecision(request: PermissionRequest, decision: 'allow' | 'deny') {
    // Drop optimistically; a server-side failure means the request is already
    // gone (answered elsewhere / session removed), so there is nothing to retry.
    setPermissionQueue((prev) => prev.filter((p) => !sameRequest(p, request)));
    try {
      await respondPermission(request.session_id, request.request_id, decision);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setConversations((prev) => ({
        ...prev,
        [request.session_id]: applyStreamEvent(prev[request.session_id] ?? [], {
          type: 'error',
          message: `Permission response failed: ${detail}`,
        }),
      }));
    }
  }

  function handleOpen(sessionId: string) {
    setCreating(false);
    setWorkspace((prev) => openInActivePane(prev, sessionId));
  }

  function handleOpenInSplit(sessionId: string) {
    setCreating(false);
    setWorkspace((prev) => openInSplitPane(prev, sessionId));
  }

  function handleClosePane(paneId: PaneId) {
    setWorkspace((prev) => closePane(prev, paneId));
  }

  function handleDividerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const container = workspaceRef.current;
    if (!container) return;
    const containerEl = container;
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    function update(clientX: number) {
      const rect = containerEl.getBoundingClientRect();
      const ratio = ((clientX - rect.left) / rect.width) * 100;
      setWorkspace((prev) => setSplitRatio(prev, ratio));
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      update(moveEvent.clientX);
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    }

    update(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  const selectedId = workspace.panels.find((panel) => panel.paneId === workspace.activePane)?.sessionId ?? null;
  const visiblePanels = workspace.panels
    .map((panel) => ({ panel, session: sessions.find((s) => s.session_id === panel.sessionId) ?? null }))
    .filter((item): item is { panel: { paneId: PaneId; sessionId: string }; session: SessionRecord } => item.session !== null);
  const pendingPermission = permissionQueue[0] ?? null;
  const pendingSession = pendingPermission
    ? sessions.find((s) => s.session_id === pendingPermission.session_id)
    : null;

  return (
    <div className={`app${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      {sidebarCollapsed ? (
        <button
          type="button"
          className="icon-btn sidebar-restore"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="Show sidebar"
          title="Show sidebar"
        >
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
            <path d="m12 9 3 3-3 3" />
          </svg>
        </button>
      ) : (
        <Sidebar
          sessions={sessions}
          connected={connected}
          selectedId={selectedId}
          onSelect={handleOpen}
          onOpenInSplit={handleOpenInSplit}
          onDelete={handleDelete}
          onNewSession={() => {
            setCreating(true);
          }}
          onToggle={() => setSidebarCollapsed(true)}
        />
      )}
      <main className="main">
        {creating ? (
          <CreateSessionForm
            agents={agents}
            onCreated={(session) => {
              setSessions((prev) => addSessionIfAbsent(prev, session));
              setCreating(false);
              setWorkspace((prev) => openInActivePane(prev, session.session_id));
            }}
            onCancel={() => setCreating(false)}
          />
        ) : visiblePanels.length > 0 ? (
          <div
            className={`workspace workspace-${visiblePanels.length}`}
            ref={workspaceRef}
            style={{ '--split-ratio': `${workspace.splitRatio}%` } as CSSProperties}
          >
            {visiblePanels.map(({ panel, session }, index) => {
              const panelHistory = historyStatus[session.session_id];
              const ownsPendingPermission = pendingPermission?.session_id === session.session_id;
              return (
                <div
                  key={panel.paneId}
                  className="workspace-panel"
                  style={visiblePanels.length === 2
                    ? { flexBasis: panel.paneId === 'left' ? 'var(--split-ratio)' : `calc(100% - var(--split-ratio))` }
                    : undefined}
                >
                  <ConversationView
                    session={session}
                    messages={conversations[session.session_id] ?? []}
                    draft={drafts[session.session_id] ?? ''}
                    onDraftChange={(text) => setDrafts((prev) => ({ ...prev, [session.session_id]: text }))}
                    onSend={(text, model) => void handleSend(session, text, model)}
                    models={models[session.session_id]?.options}
                    loading={panelHistory?.loading}
                    error={panelHistory?.error}
                    awaitingFirstResponse={awaitingFirstResponse[session.session_id] ?? false}
                    active={workspace.activePane === panel.paneId}
                    permissionHighlighted={ownsPendingPermission}
                    onActivate={() => setWorkspace((prev) => setActivePane(prev, panel.paneId))}
                    onClose={() => handleClosePane(panel.paneId)}
                  />
                  {visiblePanels.length === 2 && index === 0 && (
                    <div
                      className="workspace-divider"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize panels"
                      onPointerDown={handleDividerPointerDown}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState onNewSession={() => setCreating(true)} />
        )}
      </main>

      {pendingPermission && (
        <PermissionModal
          request={pendingPermission}
          sessionLabel={pendingSession ? `${pendingSession.name} · ${pendingSession.coding_agent}` : 'a session'}
          onDecision={(decision) => void handlePermissionDecision(pendingPermission, decision)}
        />
      )}
    </div>
  );
}
