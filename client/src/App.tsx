import { useEffect, useState } from 'react';
import { listAgents, listSessions, sendMessage } from './api';
import { ConversationView } from './components/ConversationView';
import { CreateSessionForm } from './components/CreateSessionForm';
import { EmptyState } from './components/EmptyState';
import { Sidebar } from './components/Sidebar';
import {
  applyStreamEvent,
  applyUserMessage,
  toStreamEvent,
  type ConversationMessage,
  type StreamableServerEvent,
} from './conversation';
import type { AgentId, ServerEvent, SessionRecord } from './types';

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

  const selected = sessions.find((s) => s.session_id === selectedId) ?? null;

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
    </div>
  );
}
