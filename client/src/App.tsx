import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { deleteSession, deleteTeam, getSessionMessages, getSessionModels, listAgents, listSessions, listTeamRuns, listTeams, respondPermission, selectSessionModel, sendMessage, sendTeamRequest } from './api';
import { ConversationView } from './components/ConversationView';
import { CreateSessionForm } from './components/CreateSessionForm';
import { CreateTeamForm } from './components/CreateTeamForm';
import { EmptyState } from './components/EmptyState';
import { PermissionModal } from './components/PermissionModal';
import { Sidebar } from './components/Sidebar';
import { TeamChatView, type TeamTimelineItem } from './components/TeamChatView';
import {
  applyStreamEvent,
  applyUserMessage,
  messagesToConversation,
  isDisplayableStreamEvent,
  toStreamEvent,
  type ConversationMessage,
  type StreamableServerEvent,
} from './conversation';
import type { AgentId, ModelOption, PermissionRequest, ServerEvent, SessionRecord, TeamRunWithItems, TeamWithMembers } from './types';
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
const SELECTED_TEAM_STORAGE_KEY = 'coding-agent-dashboard.selected-team.v1';

/** Prepend only if the session is not already present — both the POST response
 * and the SSE `session_created` event may deliver the same session. */
function addSessionIfAbsent(prev: SessionRecord[], session: SessionRecord): SessionRecord[] {
  return prev.some((s) => s.session_id === session.session_id) ? prev : [session, ...prev];
}

function putTimelineItem(prev: TeamTimelineItem[], item: TeamTimelineItem): TeamTimelineItem[] {
  const existing = prev.findIndex((entry) => entry.item_id === item.item_id);
  if (existing === -1) return [...prev, item];
  return prev.map((entry, index) => (index === existing ? { ...entry, ...item } : entry));
}

function teamMessageTimelineMeta(kind: string): Pick<TeamTimelineItem, 'kind' | 'label'> | null {
  if (kind === 'result') return { kind: 'result', label: 'Result' };
  if (kind === 'review') return { kind: 'review', label: 'Review' };
  if (kind === 'need_info') return { kind: 'need_info', label: 'Need info' };
  if (kind === 'proposal') return { kind: 'proposal', label: 'Proposal' };
  return null;
}

function deliveryStreamLabel(messageId: string, rootMessageId: string): string {
  return messageId === rootMessageId ? 'Leader response' : 'Delivery';
}

function deliveryActivityText(status: string): string {
  if (status === 'blocked') return 'Blocked by dependency.';
  if (status === 'pending') return 'Queued.';
  if (status === 'running') return 'Running.';
  if (status === 'done') return 'Done.';
  if (status === 'failed') return 'Failed.';
  if (status === 'cancelled') return 'Cancelled.';
  return status;
}

function deliveryActivityTime(delivery: TeamRunWithItems['deliveries'][number]): number {
  if (delivery.status === 'running') return delivery.started_at ?? delivery.created_at;
  if (delivery.status === 'done' || delivery.status === 'failed' || delivery.status === 'cancelled') {
    return delivery.finished_at ?? delivery.started_at ?? delivery.created_at;
  }
  return delivery.created_at;
}

function timelineFromRuns(runs: TeamRunWithItems[]): TeamTimelineItem[] {
  const items: TeamTimelineItem[] = [];
  for (const run of runs) {
    for (const message of run.messages) {
      if (message.kind === 'user_request') {
        items.push({
          item_id: `message:${message.message_id}`,
          run_id: run.run.run_id,
          kind: 'user_request',
          label: message.message_id === run.run.root_user_message_id ? 'User request' : 'User reply',
          text: message.content,
          status: run.run.status,
          create_time: message.create_time,
        });
      } else if (message.kind === 'final') {
        items.push({
          item_id: `message:${message.message_id}`,
          run_id: run.run.run_id,
          kind: 'final',
          label: 'Final result',
          text: message.content,
          status: 'completed',
          create_time: message.create_time,
        });
      } else if (message.kind === 'status') {
        items.push({
          item_id: `message:${message.message_id}`,
          run_id: run.run.run_id,
          kind: 'plan',
          label: 'Plan',
          text: message.content,
          status: run.run.status,
          create_time: message.create_time,
        });
      } else if (message.kind === 'assignment') {
        items.push({
          item_id: `message:${message.message_id}`,
          run_id: run.run.run_id,
          kind: 'assignment',
          label: 'Assignment',
          text: message.content,
          status: run.deliveries.find((delivery) => delivery.message_id === message.message_id)?.status,
          member_id: run.deliveries.find((delivery) => delivery.message_id === message.message_id)?.to_member_id,
          delivery_id: run.deliveries.find((delivery) => delivery.message_id === message.message_id)?.delivery_id,
          create_time: message.create_time,
        });
      } else if (message.kind === 'error') {
        items.push({
          item_id: `message:${message.message_id}`,
          run_id: run.run.run_id,
          kind: 'error',
          label: message.from_kind === 'member' ? 'Member error' : 'Run error',
          text: message.content,
          status: 'failed',
          member_id: message.from_member_id,
          create_time: message.create_time,
        });
      } else {
        const meta = teamMessageTimelineMeta(message.kind);
        if (meta) {
          const delivery = run.deliveries.find((item) => item.message_id === message.message_id);
          items.push({
            item_id: `message:${message.message_id}`,
            run_id: run.run.run_id,
            kind: meta.kind,
            label: meta.label,
            text: message.content,
            status: delivery?.status,
            member_id: message.from_member_id ?? delivery?.to_member_id,
            delivery_id: delivery?.delivery_id,
            create_time: message.create_time,
          });
        }
      }
    }

    for (const delivery of run.deliveries) {
      items.push({
        item_id: `delivery:${delivery.delivery_id}:stream`,
        run_id: run.run.run_id,
        kind: 'delivery_stream',
        label: deliveryStreamLabel(delivery.message_id, run.run.root_user_message_id),
        text: delivery.status === 'done' ? 'Completed.' : '',
        status: delivery.status,
        member_id: delivery.to_member_id,
        delivery_id: delivery.delivery_id,
        create_time: delivery.started_at ?? delivery.created_at,
      });
      items.push({
        item_id: `delivery:${delivery.delivery_id}:activity:${delivery.status}`,
        run_id: run.run.run_id,
        kind: 'delivery_activity',
        label: 'Delivery status',
        text: deliveryActivityText(delivery.status),
        status: delivery.status,
        member_id: delivery.to_member_id,
        delivery_id: delivery.delivery_id,
        create_time: deliveryActivityTime(delivery),
      });
    }
  }
  return items.sort((a, b) => a.create_time - b.create_time);
}

function memberStatusForDelivery(status: string): 'idle' | 'running' | 'waiting_permission' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'error';
  return 'idle';
}


export function App() {
  const [agents, setAgents] = useState<AgentId[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [teams, setTeams] = useState<TeamWithMembers[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState<'session' | 'team' | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamDeleteError, setTeamDeleteError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    typeof window === 'undefined' ? false : window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true',
  );
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace);
  const [conversations, setConversations] = useState<Record<string, ConversationMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [teamDrafts, setTeamDrafts] = useState<Record<string, string>>({});
  const [teamTimeline, setTeamTimeline] = useState<Record<string, TeamTimelineItem[]>>({});
  const [sendingTeamRequest, setSendingTeamRequest] = useState<Record<string, boolean>>({});
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
  const requestedTeamRuns = useRef<Set<string>>(new Set());
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
    void listTeams()
      .then((list) => {
        setTeams(list);
        if (typeof window !== 'undefined') {
          const restoredTeamId = window.localStorage.getItem(SELECTED_TEAM_STORAGE_KEY);
          if (restoredTeamId && list.some((team) => team.team_id === restoredTeamId)) {
            setSelectedTeamId(restoredTeamId);
            setWorkspace(emptyWorkspace);
          } else if (restoredTeamId) {
            window.localStorage.removeItem(SELECTED_TEAM_STORAGE_KEY);
          }
        }
      })
      .catch(() => setTeams([]))
      .finally(() => setTeamsLoaded(true));
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
    if (typeof window === 'undefined') return;
    if (selectedTeamId) {
      window.localStorage.setItem(SELECTED_TEAM_STORAGE_KEY, selectedTeamId);
    } else {
      window.localStorage.removeItem(SELECTED_TEAM_STORAGE_KEY);
    }
  }, [selectedTeamId]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      setConnected(true);
      // EventSource auto-reconnects after a drop; re-read SQLite (the single
      // source of truth) so statuses missed during the gap are reconciled.
      void listSessions().then(setSessions);
      void listTeams().then(setTeams);
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      switch (event.type) {
        case 'session_created':
          setSessions((prev) => addSessionIfAbsent(prev, event.session));
          void listTeams().then(setTeams);
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
              : [
                  ...prev,
                  {
                    session_id: event.session_id,
                    request_id: event.request_id,
                    tool_name: event.tool_name,
                    input: event.input,
                    team_context: event.team_context,
                  },
                ],
          );
          if (event.team_context) {
            const context = event.team_context;
            setTeams((prev) =>
              prev.map((team) =>
                team.team_id === context.team_id
                  ? {
                      ...team,
                      members: team.members.map((member) =>
                        member.member_id === context.member_id
                          ? {
                              ...member,
                              status: 'waiting_permission',
                              current_delivery_id: context.delivery_id,
                            }
                          : member,
                      ),
                    }
                  : team,
              ),
            );
          }
          break;
        case 'permission_response':
          // The request is resolved (by this tab or another); drop it so the
          // modal doesn't linger. Scoped to the same session: another session's
          // request that happens to share the id must stay queued. Filtering is
          // idempotent for the tab that just answered optimistically.
          setPermissionQueue((prev) => prev.filter((p) => !sameRequest(p, event)));
          if (event.team_context) {
            const context = event.team_context;
            setTeams((prev) =>
              prev.map((team) =>
                team.team_id === context.team_id
                  ? {
                      ...team,
                      members: team.members.map((member) =>
                        member.member_id === context.member_id
                          ? {
                              ...member,
                              status: 'running',
                              current_delivery_id: context.delivery_id,
                            }
                          : member,
                      ),
                    }
                  : team,
              ),
            );
          }
          break;
        case 'team_run_created':
          setTeamTimeline((prev) => {
            const withUser = putTimelineItem(prev[event.team_id] ?? [], {
              item_id: `message:${event.user_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'user_request',
              label: 'User request',
              text: event.user_message.content,
              status: event.run.status,
              create_time: event.user_message.create_time,
            });
            return {
              ...prev,
              [event.team_id]: putTimelineItem(
                putTimelineItem(withUser, {
                  item_id: `delivery:${event.delivery.delivery_id}:stream`,
                  run_id: event.run.run_id,
                  kind: 'delivery_stream',
                  label: 'Leader response',
                  text: '',
                  status: event.delivery.status,
                  member_id: event.delivery.to_member_id,
                  delivery_id: event.delivery.delivery_id,
                  create_time: event.delivery.created_at,
                }),
                {
                  item_id: `delivery:${event.delivery.delivery_id}:activity:${event.delivery.status}`,
                  run_id: event.run.run_id,
                  kind: 'delivery_activity',
                  label: 'Delivery status',
                  text: deliveryActivityText(event.delivery.status),
                  status: event.delivery.status,
                  member_id: event.delivery.to_member_id,
                  delivery_id: event.delivery.delivery_id,
                  create_time: event.delivery.created_at,
                },
              ),
            };
          });
          setTeams((prev) =>
            prev.map((team) => (team.team_id === event.team_id ? { ...team, status: 'running' } : team)),
          );
          break;
        case 'team_delivery_status_change':
          setTeamTimeline((prev) => {
            const itemId = `delivery:${event.delivery_id}:stream`;
            const existing = prev[event.team_id]?.find((item) => item.item_id === itemId);
            const items = putTimelineItem(prev[event.team_id] ?? [], {
              item_id: itemId,
              run_id: event.run_id,
              kind: 'delivery_stream',
              label: existing?.label ?? 'Delivery',
              text: existing?.text ?? '',
              status: event.status,
              member_id: event.member_id,
              delivery_id: event.delivery_id,
              create_time: existing?.create_time ?? Date.now(),
            });
            return {
              ...prev,
              [event.team_id]: putTimelineItem(items, {
                item_id: `delivery:${event.delivery_id}:activity:${event.status}`,
                run_id: event.run_id,
                kind: 'delivery_activity',
                label: 'Delivery status',
                text: deliveryActivityText(event.status),
                status: event.status,
                member_id: event.member_id,
                delivery_id: event.delivery_id,
                create_time: Date.now(),
              }),
            };
          });
          setTeams((prev) =>
            prev.map((team) =>
              team.team_id === event.team_id
                ? {
                    ...team,
                    status: event.status === 'running' ? 'running' : event.status === 'failed' ? 'error' : team.status,
                    members: team.members.map((member) =>
                      member.member_id === event.member_id
                        ? {
                            ...member,
                            status: memberStatusForDelivery(event.status),
                            current_delivery_id: event.status === 'running' ? event.delivery_id : null,
                          }
                        : member,
                    ),
                  }
                : team,
            ),
          );
          if (event.status !== 'running' && event.status !== 'pending') void listTeams().then(setTeams);
          break;
        case 'team_text_delta':
          setTeamTimeline((prev) => {
            const itemId = `delivery:${event.delivery_id}:stream`;
            const existing = prev[event.team_id]?.find((item) => item.item_id === itemId);
            return {
              ...prev,
              [event.team_id]: putTimelineItem(prev[event.team_id] ?? [], {
                item_id: itemId,
                run_id: event.run_id,
                kind: 'delivery_stream',
                label: existing?.label ?? 'Leader response',
                text: `${existing?.text ?? ''}${event.text}`,
                status: existing?.status ?? 'running',
                member_id: event.member_id,
                delivery_id: event.delivery_id,
                create_time: existing?.create_time ?? Date.now(),
              }),
            };
          });
          break;
        case 'team_run_completed':
          setTeamTimeline((prev) => ({
            ...prev,
            [event.team_id]: putTimelineItem(prev[event.team_id] ?? [], {
              item_id: `message:${event.final_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'final',
              label: 'Final result',
              text: event.final_message.content,
              status: event.run.status,
              create_time: event.final_message.create_time,
            }),
          }));
          setSendingTeamRequest((prev) => ({ ...prev, [event.team_id]: false }));
          void listTeams().then(setTeams);
          break;
        case 'team_run_waiting_user':
          setTeamTimeline((prev) => {
            const itemId = `delivery:${event.delivery.delivery_id}:stream`;
            const existing = prev[event.team_id]?.find((item) => item.item_id === itemId);
            let items = putTimelineItem(prev[event.team_id] ?? [], {
              item_id: itemId,
              run_id: event.run.run_id,
              kind: 'delivery_stream',
              label: existing?.label ?? 'Leader response',
              text: existing?.text ?? '',
              status: event.delivery.status,
              member_id: event.delivery.to_member_id,
              delivery_id: event.delivery.delivery_id,
              create_time: existing?.create_time ?? event.delivery.created_at,
            });
            items = putTimelineItem(items, {
              item_id: `delivery:${event.delivery.delivery_id}:activity:${event.delivery.status}`,
              run_id: event.run.run_id,
              kind: 'delivery_activity',
              label: 'Delivery status',
              text: deliveryActivityText(event.delivery.status),
              status: event.delivery.status,
              member_id: event.delivery.to_member_id,
              delivery_id: event.delivery.delivery_id,
              create_time: event.delivery.finished_at ?? event.question_message.create_time,
            });
            items = putTimelineItem(items, {
              item_id: `message:${event.question_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'need_info',
              label: 'Need info',
              text: event.question_message.content,
              status: event.run.status,
              member_id: event.question_message.from_member_id,
              create_time: event.question_message.create_time,
            });
            return { ...prev, [event.team_id]: items.sort((a, b) => a.create_time - b.create_time) };
          });
          setSendingTeamRequest((prev) => ({ ...prev, [event.team_id]: false }));
          void listTeams().then(setTeams);
          break;
        case 'team_run_resumed':
          setTeamTimeline((prev) => {
            let items = putTimelineItem(prev[event.team_id] ?? [], {
              item_id: `message:${event.user_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'user_request',
              label: 'User reply',
              text: event.user_message.content,
              status: event.run.status,
              create_time: event.user_message.create_time,
            });
            items = putTimelineItem(items, {
              item_id: `delivery:${event.delivery.delivery_id}:stream`,
              run_id: event.run.run_id,
              kind: 'delivery_stream',
              label: 'Leader follow-up',
              text: '',
              status: event.delivery.status,
              member_id: event.delivery.to_member_id,
              delivery_id: event.delivery.delivery_id,
              create_time: event.delivery.created_at,
            });
            items = putTimelineItem(items, {
              item_id: `delivery:${event.delivery.delivery_id}:activity:${event.delivery.status}`,
              run_id: event.run.run_id,
              kind: 'delivery_activity',
              label: 'Delivery status',
              text: deliveryActivityText(event.delivery.status),
              status: event.delivery.status,
              member_id: event.delivery.to_member_id,
              delivery_id: event.delivery.delivery_id,
              create_time: event.delivery.created_at,
            });
            return { ...prev, [event.team_id]: items.sort((a, b) => a.create_time - b.create_time) };
          });
          void listTeams().then(setTeams);
          break;
        case 'team_plan_created':
          setTeamTimeline((prev) => {
            let items = putTimelineItem(prev[event.team_id] ?? [], {
              item_id: `message:${event.plan_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'plan',
              label: 'Plan',
              text: event.plan_message.content,
              status: event.run.status,
              create_time: event.plan_message.create_time,
            });
            for (const message of event.assignment_messages) {
              const delivery = event.deliveries.find((item) => item.message_id === message.message_id);
              items = putTimelineItem(items, {
                item_id: `message:${message.message_id}`,
                run_id: event.run.run_id,
                kind: 'assignment',
                label: 'Assignment',
                text: message.content,
                status: delivery?.status,
                member_id: delivery?.to_member_id,
                delivery_id: delivery?.delivery_id,
                create_time: message.create_time,
              });
            }
            for (const delivery of event.deliveries) {
              items = putTimelineItem(items, {
                item_id: `delivery:${delivery.delivery_id}:stream`,
                run_id: event.run.run_id,
                kind: 'delivery_stream',
                label: 'Delivery',
                text: '',
                status: delivery.status,
                member_id: delivery.to_member_id,
                delivery_id: delivery.delivery_id,
                create_time: delivery.created_at,
              });
              items = putTimelineItem(items, {
                item_id: `delivery:${delivery.delivery_id}:activity:${delivery.status}`,
                run_id: event.run.run_id,
                kind: 'delivery_activity',
                label: 'Delivery status',
                text: deliveryActivityText(delivery.status),
                status: delivery.status,
                member_id: delivery.to_member_id,
                delivery_id: delivery.delivery_id,
                create_time: delivery.created_at,
              });
            }
            return { ...prev, [event.team_id]: items.sort((a, b) => a.create_time - b.create_time) };
          });
          setSendingTeamRequest((prev) => ({ ...prev, [event.team_id]: false }));
          void listTeams().then(setTeams);
          break;
        case 'team_message_created':
          setTeamTimeline((prev) => {
            let items = prev[event.team_id] ?? [];
            const meta = teamMessageTimelineMeta(event.message.kind);
            if (meta || event.message.kind === 'error') {
              items = putTimelineItem(items, {
                item_id: `message:${event.message.message_id}`,
                run_id: event.message.run_id,
                kind: meta?.kind ?? 'error',
                label: meta?.label ?? 'Member error',
                text: event.message.content,
                status: event.delivery?.status,
                member_id: event.message.from_member_id ?? event.delivery?.to_member_id,
                delivery_id: event.delivery?.delivery_id,
                create_time: event.message.create_time,
              });
            }
            if (event.delivery) {
              items = putTimelineItem(items, {
                item_id: `delivery:${event.delivery.delivery_id}:stream`,
                run_id: event.delivery.run_id,
                kind: 'delivery_stream',
                label: 'Leader follow-up',
                text: '',
                status: event.delivery.status,
                member_id: event.delivery.to_member_id,
                delivery_id: event.delivery.delivery_id,
                create_time: event.delivery.created_at,
              });
              items = putTimelineItem(items, {
                item_id: `delivery:${event.delivery.delivery_id}:activity:${event.delivery.status}`,
                run_id: event.delivery.run_id,
                kind: 'delivery_activity',
                label: 'Delivery status',
                text: deliveryActivityText(event.delivery.status),
                status: event.delivery.status,
                member_id: event.delivery.to_member_id,
                delivery_id: event.delivery.delivery_id,
                create_time: event.delivery.created_at,
              });
            }
            return { ...prev, [event.team_id]: items.sort((a, b) => a.create_time - b.create_time) };
          });
          void listTeams().then(setTeams);
          break;
        case 'team_run_failed':
          setTeamTimeline((prev) => ({
            ...prev,
            [event.team_id]: putTimelineItem(prev[event.team_id] ?? [], {
              item_id: `message:${event.error_message.message_id}`,
              run_id: event.run.run_id,
              kind: 'error',
              label: 'Run error',
              text: event.error_message.content,
              status: event.run.status,
              member_id: event.error_message.from_member_id,
              create_time: event.error_message.create_time,
            }),
          }));
          setSendingTeamRequest((prev) => ({ ...prev, [event.team_id]: false }));
          void listTeams().then(setTeams);
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

  useEffect(() => {
    if (!selectedTeamId || requestedTeamRuns.current.has(selectedTeamId)) return;
    requestedTeamRuns.current.add(selectedTeamId);
    listTeamRuns(selectedTeamId)
      .then((runs) => {
        setTeamTimeline((prev) => ({ ...prev, [selectedTeamId]: timelineFromRuns(runs) }));
      })
      .catch((err) => {
        requestedTeamRuns.current.delete(selectedTeamId);
        setTeamDeleteError(err instanceof Error ? err.message : String(err));
      });
  }, [selectedTeamId]);

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
    setCreating(null);
    setSelectedTeamId(null);
    setWorkspace((prev) => openInActivePane(prev, sessionId));
  }

  function handleOpenInSplit(sessionId: string) {
    setCreating(null);
    setSelectedTeamId(null);
    setWorkspace((prev) => openInSplitPane(prev, sessionId));
  }

  function handleSelectTeam(teamId: string) {
    setCreating(null);
    setSelectedTeamId(teamId);
    setTeamDeleteError(null);
    setWorkspace(emptyWorkspace);
  }

  async function handleDeleteTeam(teamId: string) {
    setTeamDeleteError(null);
    try {
      await deleteTeam(teamId);
      setTeams((prev) => prev.filter((team) => team.team_id !== teamId));
      if (selectedTeamId === teamId) setSelectedTeamId(null);
      setTeamDrafts((prev) => {
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
      setTeamTimeline((prev) => {
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
      setSendingTeamRequest((prev) => {
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
      void listSessions().then(setSessions);
    } catch (err) {
      setTeamDeleteError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleTeamSubmit(teamId: string, text: string) {
    setTeamDrafts((prev) => ({ ...prev, [teamId]: '' }));
    setTeamDeleteError(null);
    setSendingTeamRequest((prev) => ({ ...prev, [teamId]: true }));
    try {
      const created = await sendTeamRequest(teamId, text);
      setTeamTimeline((prev) => ({
        ...prev,
        [teamId]: timelineFromRuns([created]).reduce(
          (items, item) => putTimelineItem(items, item),
          prev[teamId] ?? [],
        ),
      }));
    } catch (err) {
      setSendingTeamRequest((prev) => ({ ...prev, [teamId]: false }));
      setTeamDeleteError(err instanceof Error ? err.message : String(err));
    }
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
  const selectedTeam = selectedTeamId ? teams.find((team) => team.team_id === selectedTeamId) ?? null : null;
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
          teams={teams}
          connected={connected}
          selectedId={selectedId}
          selectedTeamId={selectedTeamId}
          onSelect={handleOpen}
          onSelectTeam={handleSelectTeam}
          onOpenInSplit={handleOpenInSplit}
          onDelete={handleDelete}
          onDeleteTeam={(teamId) => void handleDeleteTeam(teamId)}
          onNewSession={() => {
            setCreating('session');
            setSelectedTeamId(null);
          }}
          onNewTeam={() => {
            setCreating('team');
            setSelectedTeamId(null);
          }}
          onToggle={() => setSidebarCollapsed(true)}
        />
      )}
      <main className="main">
        {creating === 'session' ? (
          <CreateSessionForm
            agents={agents}
            onCreated={(session) => {
              setSessions((prev) => addSessionIfAbsent(prev, session));
              setCreating(null);
              setSelectedTeamId(null);
              setWorkspace((prev) => openInActivePane(prev, session.session_id));
            }}
            onCancel={() => setCreating(null)}
          />
        ) : creating === 'team' ? (
          <CreateTeamForm
            agents={agents}
            onCreated={(team) => {
              setTeams((prev) => [team, ...prev.filter((item) => item.team_id !== team.team_id)]);
              setCreating(null);
              setSelectedTeamId(team.team_id);
              void listSessions().then(setSessions);
            }}
            onCancel={() => setCreating(null)}
          />
        ) : selectedTeamId ? (
          <TeamChatView
            team={selectedTeam}
            loading={!teamsLoaded}
            deleteError={teamDeleteError}
            draft={teamDrafts[selectedTeamId] ?? ''}
            items={teamTimeline[selectedTeamId] ?? []}
            sending={sendingTeamRequest[selectedTeamId] ?? false}
            pendingPermission={
              pendingPermission?.team_context?.team_id === selectedTeamId ? pendingPermission.team_context : null
            }
            onDraftChange={(text) => setTeamDrafts((prev) => ({ ...prev, [selectedTeamId]: text }))}
            onSubmit={(text) => void handleTeamSubmit(selectedTeamId, text)}
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
          <EmptyState onNewSession={() => setCreating('session')} />
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
