import { useEffect, useRef, useState } from 'react';
import { deleteSession, getSessionMessages, listAgents, listSessions, respondPermission, sendMessage } from './api';
import { ConversationView } from './components/ConversationView';
import { CreateSessionForm } from './components/CreateSessionForm';
import { EmptyState } from './components/EmptyState';
import { PermissionModal } from './components/PermissionModal';
import { Sidebar } from './components/Sidebar';
import {
  applyStreamEvent,
  applyUserMessage,
  messagesToConversation,
  toStreamEvent,
  type ConversationMessage,
  type StreamableServerEvent,
} from './conversation';
import type { AgentId, PermissionRequest, ServerEvent, SessionRecord } from './types';

/** Prepend only if the session is not already present — both the POST response
 * and the SSE `session_created` event may deliver the same session. */
function addSessionIfAbsent(prev: SessionRecord[], session: SessionRecord): SessionRecord[] {
  return prev.some((s) => s.session_id === session.session_id) ? prev : [session, ...prev];
}


export function App() {
  const [agents, setAgents] = useState<AgentId[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ConversationMessage[]>>({});
  // Outstanding permission requests, oldest first, across all sessions. The
  // modal shows the first; the rest queue behind it.
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  // Per-session status of the initial history fetch. Requested once per session
  // per mount (ref), so re-selecting an already-loaded session doesn't refetch,
  // while a failed fetch can be retried on the next select.
  const requestedHistory = useRef<Set<string>>(new Set());
  const [historyStatus, setHistoryStatus] = useState<Record<string, { loading: boolean; error?: string }>>({});

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
    void listSessions().then(setSessions);
  }, []);

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
            setConversations((prev) => ({
              ...prev,
              [sid]: applyStreamEvent(prev[sid] ?? [], streamEvent),
            }));
          }
          break;
        }
        case 'permission_request':
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

  // Load a session's history from its native store when it is selected.
  // Message bodies live in the agent's store, never in SQLite (design §4), so
  // after a refresh the view starts empty and this repopulates it. The guard
  // keeps it once-per-session; live streamed turns still append on top.
  useEffect(() => {
    const id = selectedId;
    if (!id || requestedHistory.current.has(id)) return;
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
        // Allow a retry on the next select.
        requestedHistory.current.delete(id);
        setHistoryStatus((prev) => ({
          ...prev,
          [id]: { loading: false, error: err instanceof Error ? err.message : String(err) },
        }));
      });
  }, [selectedId]);

  async function handleSend(session: SessionRecord, text: string) {
    const id = session.session_id;
    setConversations((prev) => ({ ...prev, [id]: applyUserMessage(prev[id] ?? [], text) }));
    try {
      await sendMessage(id, text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setConversations((prev) => ({
        ...prev,
        [id]: applyStreamEvent(prev[id] ?? [], { type: 'error', message: detail }),
      }));
    }
  }

  /** Drop a session everywhere: the list, its conversation, and the selection. */
  function removeSession(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    setConversations((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setSelectedId((prev) => (prev === sessionId ? null : prev));
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

  const selected = sessions.find((s) => s.session_id === selectedId) ?? null;
  const selectedHistory = selectedId ? historyStatus[selectedId] : undefined;
  const pendingPermission = permissionQueue[0] ?? null;
  const pendingSession = pendingPermission
    ? sessions.find((s) => s.session_id === pendingPermission.session_id)
    : null;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        connected={connected}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDelete={handleDelete}
        onNewSession={() => {
          setCreating(true);
          setSelectedId(null);
        }}
      />
      <main className="main">
        {creating ? (
          <CreateSessionForm
            agents={agents}
            onCreated={(session) => {
              setSessions((prev) => addSessionIfAbsent(prev, session));
              setCreating(false);
              setSelectedId(session.session_id);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : selected ? (
          <ConversationView
            session={selected}
            messages={conversations[selected.session_id] ?? []}
            onSend={(text) => void handleSend(selected, text)}
            loading={selectedHistory?.loading}
            error={selectedHistory?.error}
          />
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
