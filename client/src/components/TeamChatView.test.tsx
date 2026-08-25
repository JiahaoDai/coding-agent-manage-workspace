import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationView } from './ConversationView';
import { TeamChatView } from './TeamChatView';
import type { SessionRecord, TeamWithMembers } from '../types';

const team: TeamWithMembers = {
  team_id: 'team-1',
  name: 'Product Builder',
  cwd: '/project',
  status: 'idle',
  max_parallel_members: 1,
  create_time: 1,
  modify_time: 1,
  members: [
    {
      member_id: 'member-1',
      team_id: 'team-1',
      role: 'leader',
      coding_agent: 'fake',
      session_id: 'session-1',
      model: null,
      responsibility_prompt: 'Plan the work.',
      status: 'idle',
      current_delivery_id: null,
      create_time: 1,
      modify_time: 1,
    },
    {
      member_id: 'member-2',
      team_id: 'team-1',
      role: 'reviewer',
      coding_agent: 'fake',
      session_id: 'session-2',
      model: 'fake/fast',
      responsibility_prompt: 'Review changes.',
      status: 'running',
      current_delivery_id: 'delivery-review',
      create_time: 2,
      modify_time: 2,
    },
  ],
};

const session: SessionRecord = {
  session_id: 'dashboard-session-1',
  coding_agent: 'fake',
  real_session_id: 'native-session-1',
  name: 'Ordinary session',
  cwd: '/project',
  status: 'completed',
  model: null,
  last_error: null,
  create_time: 1,
  modify_time: 1,
};

describe('TeamChatView', () => {
  it('renders a team chat shell with member metadata, empty timeline, and composer', () => {
    const markup = renderToStaticMarkup(
      <TeamChatView
        team={team}
        draft=""
        items={[]}
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(markup).toContain('Product Builder');
    expect(markup).toContain('/project');
    expect(markup).toContain('leader');
    expect(markup).toContain('reviewer');
    expect(markup).toContain('fake · default model');
    expect(markup).toContain('fake · fake/fast');
    expect(markup).toContain('session-1');
    expect(markup).toContain('Active delivery delivery');
    expect(markup).toContain('Run activity');
    expect(markup).toContain('No team runs yet.');
    expect(markup).toContain('Send team request');
  });

  it('groups activity separately from expandable delivery streams', () => {
    const markup = renderToStaticMarkup(
      <TeamChatView
        team={team}
        draft=""
        items={[
          {
            item_id: 'message-1',
            run_id: 'run-1',
            kind: 'user_request',
            label: 'User request',
            text: 'Build the settings page.',
            status: 'running',
            create_time: 1,
          },
          {
            item_id: 'activity-queued',
            run_id: 'run-1',
            kind: 'delivery_activity',
            label: 'Delivery status',
            text: 'Queued.',
            status: 'pending',
            member_id: 'member-1',
            delivery_id: 'delivery-leader',
            create_time: 2,
          },
          {
            item_id: 'activity-running',
            run_id: 'run-1',
            kind: 'delivery_activity',
            label: 'Delivery status',
            text: 'Running.',
            status: 'running',
            member_id: 'member-2',
            delivery_id: 'delivery-review',
            create_time: 3,
          },
          {
            item_id: 'stream-1',
            run_id: 'run-1',
            kind: 'delivery_stream',
            label: 'Leader response',
            text: '{"type":"final"',
            status: 'running',
            member_id: 'member-1',
            delivery_id: 'delivery-leader',
            create_time: 4,
          },
          {
            item_id: 'stream-2',
            run_id: 'run-1',
            kind: 'delivery_stream',
            label: 'Review delivery',
            text: '[thinking] Checking tests.\n[tool start] Bash tc-1 {"command":"npm test"}\n[status] Running tests.\nREVIEW: Missing an assertion.',
            status: 'done',
            member_id: 'member-2',
            delivery_id: 'delivery-review',
            attempt_id: 'attempt-1',
            create_time: 5,
          },
          {
            item_id: 'final-1',
            run_id: 'run-1',
            kind: 'final',
            label: 'Final result',
            text: 'Settings page is ready.',
            status: 'completed',
            create_time: 6,
          },
          {
            item_id: 'plan-1',
            run_id: 'run-2',
            kind: 'plan',
            label: 'Plan',
            text: 'Implement API work, then review it.',
            status: 'running',
            create_time: 7,
          },
          {
            item_id: 'assignment-1',
            run_id: 'run-2',
            kind: 'assignment',
            label: 'Assignment',
            text: 'Assignment api -> backend-coder\n\nTask: Implement the API endpoint.',
            status: 'pending',
            member_id: 'member-2',
            delivery_id: 'delivery-review',
            create_time: 8,
          },
        ]}
        onDraftChange={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(markup).toContain('User request');
    expect(markup).toContain('Build the settings page.');
    expect(markup).toContain('Activity');
    expect(markup).toContain('Delivery streams');
    expect(markup).toContain('leader: Queued.');
    expect(markup).toContain('reviewer: Running.');
    expect(markup).toContain('Leader response');
    expect(markup).toContain('{&quot;type&quot;:&quot;final&quot;');
    expect(markup).toContain('Review delivery');
    expect(markup).toContain('[thinking] Checking tests.');
    expect(markup).toContain('[tool start] Bash tc-1 {&quot;command&quot;:&quot;npm test&quot;}');
    expect(markup).toContain('[status] Running tests.');
    expect(markup).toContain('REVIEW: Missing an assertion.');
    expect(markup).toContain('attempt attempt-');
    expect(markup).toContain('Final result');
    expect(markup).toContain('Settings page is ready.');
    expect(markup).toContain('completed');
    expect(markup).toContain('Plan');
    expect(markup).toContain('Implement API work, then review it.');
    expect(markup).toContain('Assignment api -&gt; backend-coder');
    expect(markup).toContain('pending');
  });

  it('handles loading and missing-team states cleanly', () => {
    const loading = renderToStaticMarkup(
      <TeamChatView team={null} loading draft="" onDraftChange={() => {}} onSubmit={() => {}} />,
    );
    const missing = renderToStaticMarkup(
      <TeamChatView team={null} draft="" onDraftChange={() => {}} onSubmit={() => {}} />,
    );

    expect(loading).toContain('Loading team...');
    expect(loading).toContain('aria-busy="true"');
    expect(missing).toContain('Team not found');
  });

  it('keeps the ordinary session workflow renderable beside team chat work', () => {
    const markup = renderToStaticMarkup(
      <ConversationView session={session} messages={[]} onSend={() => {}} />,
    );

    expect(markup).toContain('Ordinary session');
    expect(markup).toContain('Send a message to start the conversation.');
    expect(markup).toContain('aria-label="Send"');
  });
});
