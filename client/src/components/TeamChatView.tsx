import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import type { TeamWithMembers } from '../types';

export interface TeamTimelineItem {
  item_id: string;
  run_id: string;
  kind: 'user_request' | 'leader_response' | 'final' | 'error';
  label: string;
  text: string;
  status?: string;
  create_time: number;
}

export function TeamChatView({
  team,
  loading = false,
  deleteError = null,
  draft,
  items = [],
  sending = false,
  onDraftChange,
  onSubmit,
}: {
  team: TeamWithMembers | null;
  loading?: boolean;
  deleteError?: string | null;
  draft: string;
  items?: TeamTimelineItem[];
  sending?: boolean;
  onDraftChange: (text: string) => void;
  onSubmit: (text: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const teamRunning = team?.status === 'running';
  const canSubmit = draft.trim() !== '' && team !== null && !loading && !sending && !teamRunning;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!canSubmit || text === '') return;
    onSubmit(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  if (loading) {
    return (
      <section className="team-chat team-chat-state" aria-busy="true">
        <p className="conversation-empty">Loading team...</p>
      </section>
    );
  }

  if (!team) {
    return (
      <section className="team-chat team-chat-state" aria-labelledby="team-missing-title">
        <h2 id="team-missing-title">Team not found</h2>
        {deleteError && (
          <p className="error team-delete-error" role="alert">
            {deleteError}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="team-chat" aria-labelledby="team-chat-title">
      <header className="team-chat-header">
        <div className="team-chat-heading">
          <p className="team-overview-kicker">Agent team</p>
          <h2 id="team-chat-title">{team.name}</h2>
          <p className="team-overview-cwd" title={team.cwd}>
            {team.cwd}
          </p>
        </div>
        <span className="team-status">{team.status}</span>
      </header>

      {deleteError && (
        <p className="error team-delete-error" role="alert">
          {deleteError}
        </p>
      )}

      <div className="team-chat-body">
        <aside className="team-roster" aria-label="Team members">
          {team.members.map((member) => (
            <article className="team-member-card" key={member.member_id}>
              <div className="team-member-card-head">
                <h3>{member.role}</h3>
                <span>{member.status}</span>
              </div>
              <p className="team-member-meta">
                {member.coding_agent}
                {member.model ? ` · ${member.model}` : ' · default model'}
              </p>
              <p className="team-member-session" title={member.session_id}>
                {member.session_id}
              </p>
              <p className="team-member-prompt">{member.responsibility_prompt}</p>
            </article>
          ))}
        </aside>

        <div className="team-run-panel" aria-label="Team run timeline">
          <div className="team-run-header">
            <h3>Run timeline</h3>
          </div>
          <div className="team-run-timeline" aria-live="polite">
            {items.length === 0 ? (
              <p className="conversation-empty">No team runs yet.</p>
            ) : (
              items.map((item) => (
                <article className={`team-run-event team-run-event-${item.kind}`} key={item.item_id}>
                  <div className="team-run-event-head">
                    <span>{item.label}</span>
                    <time dateTime={new Date(item.create_time).toISOString()}>
                      {new Date(item.create_time).toLocaleTimeString()}
                    </time>
                  </div>
                  <p>{item.text}</p>
                  {item.status && <span className="team-run-event-status">{item.status}</span>}
                </article>
              ))
            )}
          </div>
        </div>
      </div>

      <form className="composer team-composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={teamRunning ? 'Team is running...' : 'Message the team...'}
          disabled={teamRunning || sending}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left" aria-hidden="true">
            <span className="composer-plus">
              <TeamIcon />
            </span>
          </div>
          <div className="composer-toolbar-right">
            <button type="submit" className="composer-send" disabled={!canSubmit} aria-label="Send team request">
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
    </section>
  );
}

function TeamIcon() {
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
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
