import type {
  TeamMessageDeliveryRecord,
  TeamMessageRecord,
  TeamRunWithItems,
  TeamWithMembers,
} from './types';

type TeamDeliveryAttemptRecord = TeamRunWithItems['attempts'][number];

interface SequenceParticipant {
  id: string;
  label: string;
  kind: 'user' | 'member' | 'system';
}

interface SequenceEvent {
  id: string;
  from_id: string;
  to_id: string;
  label: string;
  status: string;
  time: number;
  message: TeamMessageRecord;
  delivery: TeamMessageDeliveryRecord | null;
  attempts: TeamDeliveryAttemptRecord[];
}

export interface TeamFlowSequence {
  participants: SequenceParticipant[];
  events: SequenceEvent[];
}

const USER_ID = 'user';
const SYSTEM_ID = 'system';

export function buildTeamFlowSequence(team: TeamWithMembers, runItems: TeamRunWithItems): TeamFlowSequence {
  const memberById = new Map(team.members.map((member) => [member.member_id, member]));
  const messagesById = new Map(runItems.messages.map((message) => [message.message_id, message]));
  const attemptsByDeliveryId = groupBy(runItems.attempts, (attempt) => attempt.delivery_id);
  const participants: SequenceParticipant[] = [
    { id: USER_ID, label: 'User', kind: 'user' },
    ...team.members
      .slice()
      .sort((a, b) => memberOrder(a.role) - memberOrder(b.role) || a.create_time - b.create_time)
      .map((member) => ({ id: member.member_id, label: member.role, kind: 'member' as const })),
  ];
  const participantIds = new Set(participants.map((participant) => participant.id));
  const events: SequenceEvent[] = [];
  const deliveredMessageIds = new Set<string>();

  for (const delivery of [...runItems.deliveries].sort(deliverySort)) {
    const message = messagesById.get(delivery.message_id);
    if (!message) continue;
    const from_id = actorIdForMessage(message);
    if (!participantIds.has(from_id)) {
      participants.push({ id: from_id, label: from_id === SYSTEM_ID ? 'System' : 'Unknown', kind: from_id === SYSTEM_ID ? 'system' : 'member' });
      participantIds.add(from_id);
    }
    if (!participantIds.has(delivery.to_member_id)) {
      participants.push({ id: delivery.to_member_id, label: memberById.get(delivery.to_member_id)?.role ?? 'Unknown', kind: 'member' });
      participantIds.add(delivery.to_member_id);
    }
    deliveredMessageIds.add(message.message_id);
    events.push({
      id: `delivery:${delivery.delivery_id}`,
      from_id,
      to_id: delivery.to_member_id,
      label: eventLabel(message, delivery),
      status: delivery.status,
      time: delivery.created_at,
      message,
      delivery,
      attempts: attemptsByDeliveryId.get(delivery.delivery_id) ?? [],
    });
  }

  for (const message of [...runItems.messages].sort((a, b) => a.create_time - b.create_time)) {
    if (deliveredMessageIds.has(message.message_id)) continue;
    if (message.kind !== 'final' && message.kind !== 'need_info') continue;
    const from_id = actorIdForMessage(message);
    if (!participantIds.has(from_id)) {
      participants.push({ id: from_id, label: memberById.get(from_id)?.role ?? 'Unknown', kind: 'member' });
      participantIds.add(from_id);
    }
    events.push({
      id: `message:${message.message_id}`,
      from_id,
      to_id: USER_ID,
      label: message.kind === 'final' ? 'final_result' : 'need_info',
      status: message.kind,
      time: message.create_time,
      message,
      delivery: null,
      attempts: [],
    });
  }

  return { participants, events: events.sort((a, b) => a.time - b.time) };
}

export function buildTeamFlowExportHtml(team: TeamWithMembers, runItems: TeamRunWithItems): string {
  return buildTeamRunsFlowExportHtml(team, [runItems]);
}

export function buildTeamRunsFlowExportHtml(team: TeamWithMembers, runItems: TeamRunWithItems[]): string {
  const runs = [...runItems].sort((a, b) => a.run.create_time - b.run.create_time);
  const totalEvents = runs.reduce((count, run) => count + buildTeamFlowSequence(team, run).events.length, 0);
  const partial = runs.some((run) => run.run.status === 'running' || run.run.status === 'waiting_user');
  const title = `${team.name} message flow`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${flowStyles()}</style>
</head>
<body>
  <main class="page">
    <header class="page-header">
      <div>
        <p class="eyebrow">Agent Team Message Flow${partial ? ' / partial' : ''}</p>
        <h1>${escapeHtml(team.name)}</h1>
        <p class="path">${escapeHtml(team.cwd)}</p>
      </div>
      <dl>
        <div><dt>Runs</dt><dd>${runs.length}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(team.status)}</dd></div>
        <div><dt>Deliveries</dt><dd>${totalEvents}</dd></div>
      </dl>
    </header>
    ${runs.length > 0 ? runs.map((run, index) => renderRunSection(team, run, index + 1)).join('') : '<p class="empty">No team runs to export.</p>'}
  </main>
</body>
</html>`;
}

export function teamFlowExportFileName(team: TeamWithMembers, runItems: TeamRunWithItems): string {
  return `agent-team-flow-${slug(team.name)}-${shortId(runItems.run.run_id)}.html`;
}

export function teamRunsFlowExportFileName(team: TeamWithMembers, runItems: TeamRunWithItems[]): string {
  const suffix = runItems.length === 1 ? shortId(runItems[0].run.run_id) : `${runItems.length}-runs`;
  return `agent-team-flow-${slug(team.name)}-${suffix}.html`;
}

function renderRunSection(team: TeamWithMembers, runItems: TeamRunWithItems, runNumber: number): string {
  const sequence = buildTeamFlowSequence(team, runItems);
  const root = runItems.messages.find((message) => message.message_id === runItems.run.root_user_message_id);
  return `<section class="run-section">
    <header class="run-header">
      <div>
        <span>Conversation ${runNumber}</span>
        <strong>${escapeHtml(root ? shortSummary(root.content, 86) : 'Run')}</strong>
      </div>
      <p>run ${escapeHtml(shortId(runItems.run.run_id))} · ${escapeHtml(runItems.run.status)} · ${sequence.events.length} deliveries</p>
    </header>
    ${renderSequenceDiagram(sequence, runItems.run.run_id)}
  </section>`;
}

function renderSequenceDiagram(sequence: TeamFlowSequence, diagramId: string): string {
  const laneGap = 230;
  const sidePadding = 80;
  const headerY = 56;
  const eventStartY = 160;
  const eventGap = 92;
  const participantWidth = 168;
  const participantHeight = 48;
  const eventCardWidth = 200;
  const eventCardHeight = 42;
  const width = Math.max(900, sidePadding * 2 + Math.max(1, sequence.participants.length - 1) * laneGap);
  const height = Math.max(360, eventStartY + sequence.events.length * eventGap + 84);
  const xByParticipant = new Map(
    sequence.participants.map((participant, index) => [participant.id, sidePadding + index * laneGap]),
  );
  const markerId = `arrow-${escapeClass(diagramId)}`;

  return `<section class="sequence-shell">
    <div class="sequence-scroll">
      <svg class="sequence" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Team delivery sequence diagram">
        <defs>
          <marker id="${markerId}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 1.5 L 9 5 L 0 8.5 z"></path>
          </marker>
        </defs>
        ${sequence.participants.map((participant) => renderParticipant(participant, xByParticipant.get(participant.id) ?? sidePadding, headerY, participantWidth, participantHeight, height)).join('')}
        ${sequence.events.map((event, index) => renderEvent(event, index, xByParticipant, eventStartY, eventGap, eventCardWidth, eventCardHeight, markerId)).join('')}
      </svg>
    </div>
    ${sequence.events.map(renderEventDetail).join('')}
  </section>`;
}

function renderParticipant(
  participant: SequenceParticipant,
  centerX: number,
  y: number,
  width: number,
  height: number,
  diagramHeight: number,
): string {
  const x = centerX - width / 2;
  return `<g class="participant participant-${escapeClass(participant.kind)}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14"></rect>
    <text x="${centerX}" y="${y + 30}" text-anchor="middle">${escapeHtml(participant.label)}</text>
    <line class="lifeline" x1="${centerX}" y1="${y + height + 18}" x2="${centerX}" y2="${diagramHeight - 34}"></line>
  </g>`;
}

function renderEvent(
  event: SequenceEvent,
  index: number,
  xByParticipant: Map<string, number>,
  startY: number,
  gap: number,
  cardWidth: number,
  cardHeight: number,
  markerId: string,
): string {
  const fromX = xByParticipant.get(event.from_id) ?? 80;
  const toX = xByParticipant.get(event.to_id) ?? fromX;
  const y = startY + index * gap;
  const sameLane = fromX === toX;
  const lineStart = sameLane ? fromX + 34 : fromX;
  const lineEnd = sameLane ? toX + 34 : toX;
  const cardX = sameLane ? fromX + 48 : (fromX + toX) / 2 - cardWidth / 2;
  const marker = sameLane ? '' : ` marker-end="url(#${markerId})"`;
  const line = sameLane
    ? `<path class="message-line" d="M ${fromX} ${y} C ${fromX + 96} ${y}, ${toX + 96} ${y + 42}, ${toX + 34} ${y + 42}" marker-end="url(#${markerId})"></path>`
    : `<line class="message-line" x1="${lineStart}" y1="${y}" x2="${lineEnd}" y2="${y}"${marker}></line>`;
  return `<g class="event event-${escapeClass(event.status)}">
    ${line}
    <rect class="event-card" x="${cardX}" y="${y - cardHeight - 10}" width="${cardWidth}" height="${cardHeight}" rx="10"></rect>
    <text class="event-kind" x="${cardX + 12}" y="${y - cardHeight + 8}">${escapeHtml(event.label)}</text>
    <text class="event-summary" x="${cardX + 12}" y="${y - 16}">${escapeHtml(shortSummary(event.message.content, 32))}</text>
    <a href="#${detailId(event.id)}" aria-label="Open message detail">
      <circle class="event-dot" cx="${toX}" cy="${y}" r="8"></circle>
    </a>
  </g>`;
}

function renderEventDetail(event: SequenceEvent): string {
  return `<section class="detail-panel" id="${detailId(event.id)}">
    <a class="detail-close" href="#">Close</a>
    <h2>${escapeHtml(event.label)}</h2>
    <p class="detail-meta">
      ${escapeHtml(event.from_id)} -> ${escapeHtml(event.to_id)}
      ${event.delivery ? ` · delivery ${escapeHtml(shortId(event.delivery.delivery_id))} · ${escapeHtml(event.delivery.status)}` : ''}
    </p>
    ${renderMessageRecord(event.message)}
    ${event.delivery ? renderDeliveryRecord(event.delivery) : ''}
    ${event.attempts.map(renderAttemptRecord).join('')}
  </section>`;
}

function renderMessageRecord(message: TeamMessageRecord): string {
  return `<article>
    <h3>${escapeHtml(message.kind)} · ${escapeHtml(shortId(message.message_id))}</h3>
    <pre>${escapeHtml(message.content)}</pre>
  </article>`;
}

function renderDeliveryRecord(delivery: TeamMessageDeliveryRecord): string {
  return `<article>
    <h3>delivery · ${escapeHtml(shortId(delivery.delivery_id))} · ${escapeHtml(delivery.status)}</h3>
    <pre>${escapeHtml(delivery.error ?? 'No delivery error.')}</pre>
  </article>`;
}

function renderAttemptRecord(attempt: TeamDeliveryAttemptRecord): string {
  return `<article>
    <h3>attempt ${attempt.attempt_number} · ${escapeHtml(attempt.status)}</h3>
    <pre>${escapeHtml([attempt.output, attempt.error].filter(Boolean).join('\n\n') || 'No output captured.')}</pre>
  </article>`;
}

function actorIdForMessage(message: TeamMessageRecord): string {
  if (message.from_kind === 'user') return USER_ID;
  if (message.from_kind === 'system') return SYSTEM_ID;
  return message.from_member_id ?? SYSTEM_ID;
}

function eventLabel(message: TeamMessageRecord, delivery: TeamMessageDeliveryRecord): string {
  const base = message.kind === 'user_request' ? 'user_request' : message.kind;
  return `${base} -> ${shortId(delivery.delivery_id)}`;
}

function deliverySort(a: TeamMessageDeliveryRecord, b: TeamMessageDeliveryRecord): number {
  return a.created_at - b.created_at || a.enqueue_seq - b.enqueue_seq || a.delivery_id.localeCompare(b.delivery_id);
}

function memberOrder(role: string): number {
  return role === 'leader' ? 0 : 1;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}

function detailId(id: string): string {
  return `detail-${escapeClass(id)}`;
}

function shortSummary(value: string, max = 64): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) return 'empty';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeClass(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function flowStyles(): string {
  return `
    :root {
      --bg: #f7f7f4;
      --surface: #ffffff;
      --surface-muted: #f2f5f2;
      --text: #202421;
      --muted: #68716b;
      --border: #dfe5df;
      --accent: #10a37f;
      --accent-soft: #e7f6f1;
      --user: #fff5da;
      --member: #edf3ff;
      --system: #f4efff;
      --line: #74827a;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .page { width: min(1480px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .page-header { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
    .eyebrow { margin: 0 0 6px; color: var(--accent); font-size: 0.78rem; font-weight: 720; text-transform: uppercase; letter-spacing: 0; }
    h1 { margin: 0; font-size: 1.55rem; }
    .path { margin: 6px 0 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); gap: 8px; margin: 0; }
    dt { color: var(--muted); font-size: 0.72rem; }
    dd { margin: 0; font-weight: 680; }
    .sequence-shell { position: relative; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: 0 18px 45px rgba(32,36,33,0.08); overflow: hidden; }
    .run-section { margin-top: 18px; }
    .run-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
    .run-header div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .run-header span, .run-header p { margin: 0; color: var(--muted); font-size: 0.82rem; }
    .run-header strong { overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 24px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--muted); }
    .sequence-scroll { overflow-x: auto; overflow-y: visible; }
    .sequence { display: block; background:
      radial-gradient(circle at 1px 1px, rgba(104,113,107,0.14) 1px, transparent 0) 0 0 / 24px 24px,
      linear-gradient(180deg, #fbfbf8, #f5f7f3); }
    .participant rect { fill: var(--surface); stroke: var(--border); stroke-width: 1.3; }
    .participant-user rect { fill: var(--user); }
    .participant-member rect { fill: var(--accent-soft); }
    .participant-system rect { fill: var(--system); }
    .participant text { fill: var(--text); font-size: 16px; font-weight: 720; }
    .lifeline { stroke: rgba(104,113,107,0.38); stroke-width: 1.4; stroke-dasharray: 6 8; }
    .message-line { stroke: var(--line); stroke-width: 2.2; fill: none; stroke-linecap: round; }
    marker path { fill: var(--line); stroke: none; }
    .event-card { fill: var(--surface); stroke: var(--border); stroke-width: 1.2; filter: drop-shadow(0 8px 18px rgba(32,36,33,0.08)); }
    .event-kind { fill: var(--text); font-size: 12px; font-weight: 720; }
    .event-summary { fill: var(--muted); font-size: 11px; }
    .event-dot { fill: var(--accent); stroke: #fff; stroke-width: 2; cursor: pointer; }
    .event-failed .message-line,
    .event-error .message-line { stroke: #c24135; }
    .event-failed .event-dot,
    .event-error .event-dot { fill: #c24135; }
    .detail-panel { position: fixed; inset: 32px; z-index: 20; display: none; width: min(960px, calc(100vw - 64px)); max-height: calc(100vh - 64px); margin: auto; overflow: auto; padding: 20px; border: 1px solid var(--border); border-radius: 16px; background: #fff; box-shadow: 0 28px 80px rgba(32,36,33,0.24); }
    .detail-panel:target { display: block; }
    .detail-close { position: sticky; top: 0; float: right; border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; background: #fff; color: var(--text); font-size: 0.84rem; font-weight: 680; text-decoration: none; }
    .detail-panel h2 { margin: 0 0 6px; font-size: 1.2rem; }
    .detail-meta { margin: 0 0 14px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    .detail-panel article { margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-muted); }
    .detail-panel h3 { margin: 0 0 8px; color: #4b5563; font-size: 0.82rem; }
    pre { max-height: 440px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86rem; line-height: 1.55; }
    @media (max-width: 760px) {
      .page { width: calc(100vw - 20px); padding-top: 16px; }
      .page-header { flex-direction: column; }
      dl { grid-template-columns: 1fr; }
      .detail-panel { inset: 12px; width: calc(100vw - 24px); max-height: calc(100vh - 24px); }
    }
  `;
}
