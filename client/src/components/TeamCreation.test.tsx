import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateTeamForm } from './CreateTeamForm';
import { TeamList } from './TeamList';
import { TeamOverview } from './TeamOverview';
import type { TeamWithMembers } from '../types';

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
      initialized_at: null,
      create_time: 1,
      modify_time: 1,
    },
  ],
};

describe('team creation UI', () => {
  it('renders role templates and member fields for a new team', () => {
    const markup = renderToStaticMarkup(
      <CreateTeamForm agents={['fake']} onCreated={() => {}} onCancel={() => {}} />,
    );

    expect(markup).toContain('New team');
    expect(markup).toContain('Team name');
    expect(markup).toContain('leader');
    expect(markup).toContain('backend-coder');
    expect(markup).toContain('Select an agent');
    expect(markup).toContain('Select a directory first');
    expect(markup).toContain('Role prompt');
  });

  it('renders a created team with its fresh member sessions', () => {
    const markup = renderToStaticMarkup(<TeamOverview team={team} />);

    expect(markup).toContain('Product Builder');
    expect(markup).toContain('/project');
    expect(markup).toContain('leader');
    expect(markup).toContain('fake · default model');
    expect(markup).toContain('session-1');
    expect(markup).not.toContain('Delete team');
  });

  it('renders the team delete action in the sidebar list', () => {
    const markup = renderToStaticMarkup(
      <TeamList teams={[team]} selectedId="team-1" onSelect={() => {}} onDelete={() => {}} />,
    );

    expect(markup).toContain('Product Builder');
    expect(markup).toContain('Delete Product Builder');
    expect(markup).toContain('team-list-delete');
  });
});
