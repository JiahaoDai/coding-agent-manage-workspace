import { useEffect, useState } from 'react';
import { listAgents, listSessions, respondPermission, sendMessage } from './api';
import { ConversationView } from './components/ConversationView';
import { CreateSessionForm } from './components/CreateSessionForm';
import { EmptyState } from './components/EmptyState';
import { PermissionModal } from './components/PermissionModal';
import { Sidebar } from './components/Sidebar';
import {
  applyStreamEvent,
  applyUserMessage,
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
        case 'text_delta':
        case 'thinking_delta':
        case 'tool_call_start':
        case 'tool_call_end':
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
