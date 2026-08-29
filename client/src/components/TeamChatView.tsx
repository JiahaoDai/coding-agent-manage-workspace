import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
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
  canExport = false,
  exporting = false,
  onDraftChange,
  onSubmit,
  onExport,
}: {
  team: TeamWithMembers | null;
  loading?: boolean;
  deleteError?: string | null;
  draft: string;
  items?: TeamTimelineItem[];
  sending?: boolean;
  pendingPermission?: TeamPermissionContext | null;
  canExport?: boolean;
  exporting?: boolean;
  onDraftChange: (text: string) => void;
  onSubmit: (text: string) => void;
  onExport?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const runContentRef = useRef<HTMLDivElement>(null);
  const [rosterWidth, setRosterWidth] = useState(28);
  const [activityWidth, setActivityWidth] = useState(42);
  const teamRunning = team?.status === 'running';
  const teamWaitingUser = team?.status === 'waiting_user';
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

  function handleBodyDividerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    startHorizontalResize(event, bodyRef.current, 18, 48, setRosterWidth);
  }

  function handleRunDividerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    startHorizontalResize(event, runContentRef.current, 25, 70, setActivityWidth);
  }

  function handleBodyDividerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    handleDividerKeyDown(event, rosterWidth, 18, 48, setRosterWidth);
  }

  function handleRunDividerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    handleDividerKeyDown(event, activityWidth, 25, 70, setActivityWidth);
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
  const latestNeedInfo = activityItems
    .filter((item) => item.kind === 'need_info')
    .sort((a, b) => b.create_time - a.create_time)[0];

  return (
    <section className="team-chat" aria-labelledby="team-chat-title">
      <header className="team-chat-header">
        <nav className="team-chat-heading" aria-label="Team location">
          <span className="team-chat-crumb">Agent Team</span>
          <span className="team-chat-separator" aria-hidden="true">
            &gt;
          </span>
          <h2 id="team-chat-title" title={team.name}>
            {team.name}
          </h2>
          <span className="team-chat-separator" aria-hidden="true">
            &gt;
          </span>
          <span className="team-chat-cwd" title={team.cwd}>
            {team.cwd}
          </span>
          <span className="team-concurrency" title="Maximum team members that can run at the same time">
            Concurrency {team.max_parallel_members}
          </span>
        </nav>
        <div className="team-chat-header-actions">
          <button
            type="button"
            className="btn btn-secondary team-export-btn"
            disabled={!canExport || exporting}
            onClick={onExport}
          >
            <ExportIcon />
            {exporting ? 'Exporting...' : 'Export Flow'}
          </button>
          <span className={`team-status team-status-${team.status}`}>{team.status}</span>
        </div>
      </header>

      {deleteError && (
        <p className="error team-delete-error" role="alert">
          {deleteError}
        </p>
      )}

      <div
        className="team-chat-body"
        ref={bodyRef}
        style={{ '--team-roster-width': `${rosterWidth}%` } as CSSProperties}
      >
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
              <p className="team-member-meta" title={member.execution_cwd}>
                {member.file_access === 'read_only' ? 'read only' : 'read/write'} · {member.execution_cwd}
              </p>
              {member.worktree_branch && member.worktree_path && (
                <p className="team-member-meta" title={member.worktree_path}>
                  {member.worktree_branch} · {member.worktree_path}
                </p>
              )}
              <p className="team-member-session" title={member.session_id}>
                {member.session_id}
              </p>
              {member.session_missing && (
                <p className="team-member-broken" title={member.session_id}>
                  Session reference missing
                </p>
              )}
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

        <div
          className="team-resizer"
          role="separator"
          aria-label="Resize team roster"
          aria-orientation="vertical"
          aria-valuemin={18}
          aria-valuemax={48}
          aria-valuenow={Math.round(rosterWidth)}
          tabIndex={0}
          onKeyDown={handleBodyDividerKeyDown}
          onPointerDown={handleBodyDividerPointerDown}
        />

        <div className="team-run-panel" aria-label="Team run timeline">
          <div className="team-run-header">
            <h3>Run activity</h3>
          </div>
          <div
            className="team-run-content"
            ref={runContentRef}
            style={{ '--team-activity-width': `${activityWidth}%` } as CSSProperties}
            aria-live="polite"
          >
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
                        <ActivityText item={item} memberRole={memberById.get(item.member_id ?? '')?.role} />
                        <div className="team-run-event-meta">
                          {item.status && <span className="team-run-event-status">{item.status}</span>}
                          {item.delivery_id && <span className="team-run-event-status">delivery {shortId(item.delivery_id)}</span>}
                          {item.attempt_id && <span className="team-run-event-status">attempt {shortId(item.attempt_id)}</span>}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <div
                  className="team-resizer"
                  role="separator"
                  aria-label="Resize delivery streams"
                  aria-orientation="vertical"
                  aria-valuemin={25}
                  aria-valuemax={70}
                  aria-valuenow={Math.round(activityWidth)}
                  tabIndex={0}
                  onKeyDown={handleRunDividerKeyDown}
                  onPointerDown={handleRunDividerPointerDown}
                />

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
                              {member ? ` · ${member.file_access} · ${member.execution_cwd}` : ''}
                            </p>
                            {item.text.trim() ? (
                              <pre>{item.text}</pre>
                            ) : (
                              <p className="team-delivery-empty">{deliveryStatusText(item.status)}</p>
                            )}
                            {member && (
                              <a
                                className="team-delivery-session"
                                href={`/api/sessions/${encodeURIComponent(member.session_id)}/messages`}
                                title={member.session_id}
                              >
                                Member session {member.session_id}
                                {member.session_missing ? ' · missing' : ''}
                              </a>
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

      {teamWaitingUser && (
        <section className="team-waiting-user-banner" role="alert" aria-live="assertive">
          <div className="team-waiting-user-head">
            <span>Need info</span>
            <strong>The team is waiting for your answer</strong>
          </div>
          {latestNeedInfo ? (
            <ActivityText item={latestNeedInfo} memberRole={memberById.get(latestNeedInfo.member_id ?? '')?.role} />
          ) : (
            <p>Answer the leader to continue this run.</p>
          )}
        </section>
      )}

      <form className="composer team-composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={teamRunning ? 'Team is running...' : teamWaitingUser ? 'Answer the leader...' : 'Message the team...'}
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

function startHorizontalResize(
  event: ReactPointerEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  minPercent: number,
  maxPercent: number,
  onResize: (value: number) => void,
) {
  if (!container) return;
  event.preventDefault();

  const update = (clientX: number) => {
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    onResize(clamp(((clientX - rect.left) / rect.width) * 100, minPercent, maxPercent));
  };
  const handlePointerMove = (pointerEvent: PointerEvent) => update(pointerEvent.clientX);
  const handlePointerUp = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  };

  update(event.clientX);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp, { once: true });
}

function handleDividerKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  value: number,
  minPercent: number,
  maxPercent: number,
  onResize: (value: number) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') {
    onResize(minPercent);
  } else if (event.key === 'End') {
    onResize(maxPercent);
  } else {
    onResize(clamp(value + (event.key === 'ArrowRight' ? 3 : -3), minPercent, maxPercent));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function ActivityText({ item, memberRole }: { item: TeamTimelineItem; memberRole: string | undefined }) {
  const text = decorateActivityText(item, memberRole);
  if (item.kind === 'delivery_activity' || item.kind === 'user_request') {
    return <p>{text}</p>;
  }
  return (
    <div className="assistant-text team-run-event-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {text}
      </ReactMarkdown>
    </div>
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

function ExportIcon() {
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
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
