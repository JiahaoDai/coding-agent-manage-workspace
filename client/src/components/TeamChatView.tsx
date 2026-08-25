import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import type { TeamPermissionContext, TeamWithMembers } from '../types';

export interface TeamTimelineItem {
  item_id: string;
  run_id: string;
  kind:
    | 'user_request'
    | 'leader_response'
    | 'delivery_stream'
    | 'delivery_activity'
    | 'plan'
    | 'assignment'
    | 'result'
    | 'review'
    | 'need_info'
    | 'proposal'
    | 'final'
    | 'error';
  label: string;
  text: string;
  status?: string;
  member_id?: string | null;
  delivery_id?: string | null;
  attempt_id?: string | null;
  create_time: number;
}

export function TeamChatView({
  team,
  loading = false,
  deleteError = null,
  draft,
  items = [],
  sending = false,
  pendingPermission = null,
  onDraftChange,
  onSubmit,
}: {
  team: TeamWithMembers | null;
  loading?: boolean;
  deleteError?: string | null;
  draft: string;
  items?: TeamTimelineItem[];
  sending?: boolean;
  pendingPermission?: TeamPermissionContext | null;
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

  const memberById = new Map(team.members.map((member) => [member.member_id, member]));
  const deliveryItems = items
    .filter((item) => item.kind === 'delivery_stream')
    .sort((a, b) => a.create_time - b.create_time);
  const activityItems = items
    .filter((item) => item.kind !== 'delivery_stream')
    .sort((a, b) => a.create_time - b.create_time);

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
            <article
              className={`team-member-card${pendingPermission?.member_id === member.member_id ? ' has-permission-request' : ''}`}
              key={member.member_id}
            >
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
              {member.current_delivery_id && (
                <p className="team-member-active" title={member.current_delivery_id}>
                  Active delivery {shortId(member.current_delivery_id)}
                </p>
              )}
              {pendingPermission?.member_id === member.member_id && (
                <p className="team-member-permission" title={pendingPermission.delivery_id}>
                  Permission pending
                </p>
              )}
              <p className="team-member-prompt">{member.responsibility_prompt}</p>
            </article>
          ))}
        </aside>

        <div className="team-run-panel" aria-label="Team run timeline">
          <div className="team-run-header">
            <h3>Run activity</h3>
          </div>
          <div className="team-run-content" aria-live="polite">
            {items.length === 0 ? (
              <p className="conversation-empty">No team runs yet.</p>
            ) : (
              <>
                <section className="team-activity-stream" aria-label="Activity stream">
                  <div className="team-section-title">
                    <h4>Activity</h4>
                    <span>{activityItems.length}</span>
                  </div>
                  <div className="team-run-timeline">
                    {activityItems.map((item) => (
                      <article className={`team-run-event team-run-event-${item.kind}`} key={item.item_id}>
                        <div className="team-run-event-head">
                          <span>{item.label}</span>
                          <time dateTime={new Date(item.create_time).toISOString()}>
                            {new Date(item.create_time).toLocaleTimeString()}
                          </time>
                        </div>
                        <p>{decorateActivityText(item, memberById.get(item.member_id ?? '')?.role)}</p>
                        <div className="team-run-event-meta">
                          {item.status && <span className="team-run-event-status">{item.status}</span>}
                          {item.delivery_id && <span className="team-run-event-status">delivery {shortId(item.delivery_id)}</span>}
                          {item.attempt_id && <span className="team-run-event-status">attempt {shortId(item.attempt_id)}</span>}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <section className="team-delivery-streams" aria-label="Delivery streams">
                  <div className="team-section-title">
                    <h4>Delivery streams</h4>
                    <span>{deliveryItems.length}</span>
                  </div>
                  <div className="team-delivery-list">
                    {deliveryItems.map((item) => {
                      const member = memberById.get(item.member_id ?? '');
                      const isRunning = item.status === 'running';
                      const permissionPending = pendingPermission?.delivery_id === item.delivery_id;
                      return (
                        <details
                          className={`team-delivery-card team-delivery-card-${item.status ?? 'unknown'}${permissionPending ? ' has-permission-request' : ''}`}
                          key={item.item_id}
                          open={isRunning || permissionPending}
                        >
                          <summary>
                            <span className="team-delivery-summary-main">
                              <span>{item.label}</span>
                              <span>{member?.role ?? 'Unknown member'}</span>
                            </span>
                            <span className="team-delivery-summary-meta">
                              {item.status ?? 'unknown'}
                              {item.delivery_id ? ` · delivery ${shortId(item.delivery_id)}` : ''}
                              {item.attempt_id ? ` · attempt ${shortId(item.attempt_id)}` : ''}
                              {permissionPending ? ' · permission pending' : ''}
                            </span>
                          </summary>
                          <div className="team-delivery-detail">
                            <p className="team-delivery-detail-meta">
                              <time dateTime={new Date(item.create_time).toISOString()}>
                                {new Date(item.create_time).toLocaleTimeString()}
                              </time>
                            </p>
                            {item.text.trim() ? (
                              <pre>{item.text}</pre>
                            ) : (
                              <p className="team-delivery-empty">{deliveryStatusText(item.status)}</p>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </section>
              </>
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

function decorateActivityText(item: TeamTimelineItem, memberRole: string | undefined): string {
  if (item.kind !== 'delivery_activity') return item.text;
  return memberRole ? `${memberRole}: ${item.text}` : item.text;
}

function deliveryStatusText(status: string | undefined): string {
  if (status === 'blocked') return 'Blocked.';
  if (status === 'pending') return 'Queued.';
  if (status === 'running') return 'Running.';
  if (status === 'done') return 'Completed.';
  if (status === 'failed') return 'Failed.';
  if (status === 'cancelled') return 'Cancelled.';
  return 'Waiting.';
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
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
