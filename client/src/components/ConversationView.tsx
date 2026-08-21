import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { AssistantPart, ConversationMessage } from '../conversation';
import { STATUS_LABEL } from '../labels';
import type { ModelOption, SessionRecord } from '../types';

function Part({ part }: { part: AssistantPart }) {
  switch (part.kind) {
    case 'text':
      return (
        <div className="assistant-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {part.text}
          </ReactMarkdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking">
          <summary>Thinking</summary>
          <div className="thinking-body">{part.text}</div>
        </details>
      );
    case 'tool':
      return (
        <details className="tool-call">
          <summary>
            <span className="tool-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 17l6-5-6-5" />
                <path d="M12 19h8" />
              </svg>
            </span>
            <span className="tool-name">{part.name}</span>
            {part.done && <span className="tool-done">done</span>}
          </summary>
          <pre className="tool-input">{JSON.stringify(part.input, null, 2)}</pre>
        </details>
      );
  }
}

function Message({ message }: { message: ConversationMessage }) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="msg-bubble">{message.text}</div>
        </div>
      );
    case 'system':
      return <div className="msg msg-system">{message.text}</div>;
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          {message.parts.map((part, index) => (
            <Part key={index} part={part} />
          ))}
        </div>
      );
  }
}

export function ConversationView({
  session,
  messages,
  onSend,
  models = [],
  modelsAvailable = false,
  loading = false,
  error = null,
  awaitingFirstResponse = false,
}: {
  session: SessionRecord;
  messages: ConversationMessage[];
  onSend: (text: string, model: string | null) => void;
  models?: ModelOption[];
  modelsAvailable?: boolean;
  /** True while the session's history is being fetched from its native store. */
  loading?: boolean;
  /** Error from loading the session's history, when there is one. */
  error?: string | null;
  /** True from prompt submission until the first displayable response event. */
  awaitingFirstResponse?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<string | null>(session.model);
  const scrollRef = useRef<HTMLDivElement>(null);

  const running = session.status === 'running';
  const canSend = !running && draft.trim() !== '';

  // Keep the newest content in view as the reply streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingFirstResponse]);

  useEffect(() => setModel(session.model), [session.session_id, session.model]);

  function submit() {
    const text = draft.trim();
    if (!canSend || text === '') return;
    onSend(text, model);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="conversation">
      <header className="conversation-header">
        <div className="conversation-heading">
          <h2 className="conversation-title">{session.name}</h2>
          <span className="conversation-sub">
            {session.coding_agent} · {session.cwd}
          </span>
        </div>
        <span className={`status status-${session.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS_LABEL[session.status]}
        </span>
      </header>

      <div className="conversation-messages" ref={scrollRef} aria-live="polite">
        {loading && messages.length === 0 ? (
          <p className="conversation-empty">Loading conversation…</p>
        ) : error && messages.length === 0 ? (
          <p className="conversation-empty">Failed to load history: {error}</p>
        ) : messages.length === 0 ? (
          <p className="conversation-empty">Send a message to start the conversation.</p>
        ) : (
          messages.map((message, index) => <Message key={index} message={message} />)
        )}
        {awaitingFirstResponse && (
          <div className="msg msg-assistant response-pending" role="status" aria-label="Agent is responding">
            <span className="response-pending-dot" />
            <span className="response-pending-dot" />
            <span className="response-pending-dot" />
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="composer-model">
          <span className="sr-only">Model</span>
          <select value={model ?? ''} onChange={(event) => setModel(event.target.value || null)} disabled={running}>
            <option value="">Use agent default</option>
            {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          {!modelsAvailable && <span className="composer-model-note">Default model</span>}
        </label>
        <textarea
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={running ? 'Agent is responding…' : 'Send a message…'}
          disabled={running}
        />
        <button type="submit" className="composer-send" disabled={!canSend} aria-label="Send">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
