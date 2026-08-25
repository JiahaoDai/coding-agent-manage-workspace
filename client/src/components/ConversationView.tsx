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
  draft: controlledDraft,
  onDraftChange,
  models = [],
  loading = false,
  error = null,
  awaitingFirstResponse = false,
  active = false,
  permissionHighlighted = false,
  onActivate,
  onClose,
}: {
  session: SessionRecord;
  messages: ConversationMessage[];
  onSend: (text: string, model: string | null) => void;
  draft?: string;
  onDraftChange?: (text: string) => void;
  models?: ModelOption[];
  /** True while the session's history is being fetched from its native store. */
  loading?: boolean;
  /** Error from loading the session's history, when there is one. */
  error?: string | null;
  /** True from prompt submission until the first displayable response event. */
  awaitingFirstResponse?: boolean;
  /** Whether this panel is the active workspace target. */
  active?: boolean;
  /** Whether this panel owns the currently visible permission request. */
  permissionHighlighted?: boolean;
  onActivate?: () => void;
  onClose?: () => void;
}) {
  const [internalDraft, setInternalDraft] = useState('');
  const [model, setModel] = useState<string | null>(session.model);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draft = controlledDraft ?? internalDraft;

  const running = session.status === 'running';
  const canSend = !running && draft.trim() !== '';
  const selectedModelLabel = model
    ? (models.find((option) => option.id === model)?.label ?? model)
    : 'Agent default';

  // Keep the newest content in view as the reply streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingFirstResponse]);

  useEffect(() => setModel(session.model), [session.session_id, session.model]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  function setDraft(text: string) {
    if (onDraftChange) {
      onDraftChange(text);
    } else {
      setInternalDraft(text);
    }
  }

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
    <div
      className={`conversation${active ? ' is-active' : ''}${permissionHighlighted ? ' has-permission-request' : ''}`}
      onPointerDown={onActivate}
    >
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
        {onClose && (
          <button type="button" className="icon-btn conversation-close" onClick={onClose} aria-label={`Close ${session.name}`}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
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
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={running ? 'Agent is responding…' : 'Send a message…'}
          disabled={running}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left" aria-hidden="true">
            <span className="composer-plus">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </span>
          </div>
          <div className="composer-toolbar-right">
            <label className="composer-model">
              <span className="sr-only">Model</span>
              <span className="composer-model-label" aria-hidden="true">{selectedModelLabel}</span>
              <select value={model ?? ''} onChange={(event) => setModel(event.target.value || null)} disabled={running}>
                <option value="">Use agent default</option>
                {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <svg
                className="composer-model-chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </label>
            <button type="submit" className="composer-send" disabled={!canSend} aria-label="Send">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
