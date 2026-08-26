import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sidebar } from './Sidebar';
import type { SessionRecord, TeamWithMembers } from '../types';

const session: SessionRecord = {
  session_id: 'session-1',
  coding_agent: 'fake',
  real_session_id: 'native-1',
  name: 'Checkout work',
  cwd: '/project',
  status: 'completed',
  model: null,
  last_error: null,
  create_time: 1,
  modify_time: 1,
};

const team: TeamWithMembers = {
  team_id: 'team-1',
  name: 'Product Team',
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
      session_id: 'session-leader',
      model: null,
      responsibility_prompt: 'Lead the team.',
      status: 'idle',
      current_delivery_id: null,
      initialized_at: null,
      create_time: 1,
      modify_time: 1,
    },
  ],
};

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return renderToStaticMarkup(
    <Sidebar
      sessions={[session]}
      teams={[team]}
      connected
      selectedId={null}
      selectedTeamId={null}
      onSelect={() => {}}
      onSelectTeam={() => {}}
      onOpenInSplit={() => {}}
      onDelete={() => {}}
      onDeleteTeam={() => {}}
      onNewSession={() => {}}
      onNewTeam={() => {}}
      onToggle={() => {}}
      {...props}
    />,
  );
}

describe('Sidebar', () => {
  it('shows the sessions view by default', () => {
    const markup = renderSidebar();

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('Sessions');
    expect(markup).toContain('Teams');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('New session');
    expect(markup).toContain('Checkout work');
    expect(markup).not.toContain('New team');
    expect(markup).not.toContain('Product Team');
  });

  it('opens the teams view when a team is selected', () => {
    const markup = renderSidebar({ selectedTeamId: 'team-1' });

    expect(markup).toContain('New team');
    expect(markup).toContain('Product Team');
    expect(markup).toContain('1 members · idle');
    expect(markup).not.toContain('New session');
    expect(markup).not.toContain('Checkout work');
  });
});
