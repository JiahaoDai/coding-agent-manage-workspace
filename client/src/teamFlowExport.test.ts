import { describe, expect, it } from 'vitest';
import {
  buildTeamFlowExportHtml,
  buildTeamFlowSequence,
  buildTeamRunsFlowExportHtml,
  teamFlowExportFileName,
  teamRunsFlowExportFileName,
} from './teamFlowExport';
import type { TeamRunWithItems, TeamWithMembers } from './types';

const team: TeamWithMembers = {
  team_id: 'team-1',
  name: 'Product Builder',
  cwd: '/project',
  status: 'idle',
  max_parallel_members: 1,
  create_time: 1,
  modify_time: 1,
  members: [
    member('leader-1', 'leader', 'session-leader', 'Lead the team.', 'read_only', 1),
    member('architect-1', 'architect', 'session-architect', 'Design the solution.', 'read_write', 2),
    member('pm-1', 'PM', 'session-pm', 'Clarify product needs.', 'read_only', 3),
  ],
};

function member(
  member_id: string,
  role: string,
  session_id: string,
  responsibility_prompt: string,
  file_access: 'read_only' | 'read_write',
  time: number,
): TeamWithMembers['members'][number] {
  return {
    member_id,
    team_id: 'team-1',
    role,
    coding_agent: 'fake',
    session_id,
    model: null,
    responsibility_prompt,
    status: 'idle',
    current_delivery_id: null,
    initialized_at: null,
    file_access,
    execution_cwd: '/project',
    worktree_path: null,
    worktree_branch: null,
    create_time: time,
    modify_time: time,
  };
}

const runItems: TeamRunWithItems = {
  run: {
    run_id: 'run-123456',
    team_id: 'team-1',
    root_user_message_id: 'msg-user',
    status: 'completed',
    max_rounds: 8,
    current_round: 1,
    create_time: 1_000,
    finish_time: 10_000,
  },
  messages: [
    message('msg-user', null, 'user', 'user_request', 'Build the export flow.', 1_000),
    message('msg-architect', 'leader-1', 'member', 'assignment', 'Architect the diagram.', 2_000),
    message('msg-architect-result', 'architect-1', 'member', 'result', 'Use sequence arrows.', 3_000),
    message('msg-pm', 'leader-1', 'member', 'assignment', 'Check product readability.', 4_000),
    message('msg-pm-need', 'pm-1', 'member', 'need_info', 'Which audience?', 5_000),
    message('msg-user-reply', null, 'user', 'user_request', 'For developers.', 6_000),
    message('msg-pm-again', 'leader-1', 'member', 'assignment', 'Review for developers.', 7_000),
    message('msg-pm-result', 'pm-1', 'member', 'review', 'Looks understandable.', 8_000),
    message('msg-final', 'leader-1', 'member', 'final', '<final>done</final>', 10_000),
  ],
  deliveries: [
    delivery('delivery-root', 'msg-user', 'leader-1', 1_000, 1),
    delivery('delivery-architect', 'msg-architect', 'architect-1', 2_000, 1),
    delivery('delivery-architect-return', 'msg-architect-result', 'leader-1', 3_000, 2),
    delivery('delivery-pm', 'msg-pm', 'pm-1', 4_000, 1),
    delivery('delivery-need', 'msg-pm-need', 'leader-1', 5_000, 3),
    delivery('delivery-user-reply', 'msg-user-reply', 'leader-1', 6_000, 4),
    delivery('delivery-pm-again', 'msg-pm-again', 'pm-1', 7_000, 2),
    delivery('delivery-pm-return', 'msg-pm-result', 'leader-1', 8_000, 5),
  ],
  attempts: [
    {
      attempt_id: 'attempt-architect',
      delivery_id: 'delivery-architect',
      attempt_number: 1,
      status: 'done',
      started_at: 2_100,
      finished_at: 2_900,
      output: 'created sequence diagram',
      error: null,
    },
  ],
  dependencies: [],
};

describe('team flow export', () => {
  it('builds a delivery-backed sequence instead of a fixed leader-agent-final template', () => {
    const sequence = buildTeamFlowSequence(team, runItems);

    expect(sequence.participants.map((participant) => participant.label)).toEqual(['User', 'leader', 'architect', 'PM']);
    expect(sequence.events.map((event) => `${event.from_id}->${event.to_id}:${event.message.kind}`)).toEqual([
      'user->leader-1:user_request',
      'leader-1->architect-1:assignment',
      'architect-1->leader-1:result',
      'leader-1->pm-1:assignment',
      'pm-1->leader-1:need_info',
      'user->leader-1:user_request',
      'leader-1->pm-1:assignment',
      'pm-1->leader-1:review',
      'leader-1->user:final',
    ]);
  });

  it('exports one stable SVG coordinate system with modal details and escaped content', () => {
    const html = buildTeamFlowExportHtml(team, runItems);

    expect(html).toContain('<svg class="sequence"');
    expect(html).toContain('class="sequence-scroll"');
    expect(html).toContain('overflow-y: visible');
    expect(html).toContain('delivery-pm-again');
    expect(html).toContain('class="detail-panel"');
    expect(html).toContain('&lt;final&gt;done&lt;/final&gt;');
    expect(html).not.toContain('<final>done</final>');
    expect(teamFlowExportFileName(team, runItems)).toBe('agent-team-flow-product-builder-run-1234.html');
  });

  it('exports every run in a team instead of only the latest conversation', () => {
    const secondRun = {
      ...runItems,
      run: {
        ...runItems.run,
        run_id: 'run-abcdef',
        root_user_message_id: 'msg-user-second',
        create_time: 20_000,
        finish_time: 24_000,
      },
      messages: [
        message('msg-user-second', null, 'user', 'user_request', 'Second conversation request.', 20_000),
        message('msg-final-second', 'leader-1', 'member', 'final', 'Second final answer.', 24_000),
      ],
      deliveries: [delivery('delivery-second-root', 'msg-user-second', 'leader-1', 20_000, 1)],
      attempts: [],
      dependencies: [],
    } satisfies TeamRunWithItems;

    const html = buildTeamRunsFlowExportHtml(team, [runItems, secondRun]);

    expect(html).toContain('Conversation 1');
    expect(html).toContain('Build the export flow.');
    expect(html).toContain('Conversation 2');
    expect(html).toContain('Second conversation request.');
    expect(html).toContain('Second final answer.');
    expect(html).toContain('<dt>Runs</dt><dd>2</dd>');
    expect(teamRunsFlowExportFileName(team, [runItems, secondRun])).toBe('agent-team-flow-product-builder-2-runs.html');
  });
});

function message(
  message_id: string,
  from_member_id: string | null,
  from_kind: 'user' | 'member' | 'system',
  kind: TeamRunWithItems['messages'][number]['kind'],
  content: string,
  create_time: number,
): TeamRunWithItems['messages'][number] {
  return {
    message_id,
    team_id: 'team-1',
    run_id: 'run-123456',
    from_member_id,
    from_kind,
    kind,
    content,
    create_time,
  };
}

function delivery(
  delivery_id: string,
  message_id: string,
  to_member_id: string,
  created_at: number,
  enqueue_seq: number,
): TeamRunWithItems['deliveries'][number] {
  return {
    delivery_id,
    message_id,
    team_id: 'team-1',
    run_id: 'run-123456',
    to_member_id,
    status: 'done',
    enqueue_seq,
    created_at,
    started_at: created_at + 10,
    finished_at: created_at + 100,
    error: null,
    max_attempts: 3,
    retry_after: null,
  };
}
