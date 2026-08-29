import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreateTeamForm, parseParallelMembers } from './CreateTeamForm';
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
      file_access: 'read_only',
      execution_cwd: '/project',
      worktree_path: null,
      worktree_branch: null,
      create_time: 1,
      modify_time: 1,
    },
  ],
};

const isolatedTeam: TeamWithMembers = {
  ...team,
  members: [
    {
      ...team.members[0],
      file_access: 'read_write',
      execution_cwd: '/workspace/.agent-team-worktrees/team-1/backend-coder',
      worktree_path: '/workspace/.agent-team-worktrees/team-1/backend-coder',
      worktree_branch: 'agent-team/team-1/backend-coder',
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
    expect(markup).toContain('Use git worktree isolation for read/write members');
    expect(markup).toContain('Max parallel members');
    expect(markup).toContain('Use a number from 1 to 8.');
    expect(markup).toContain('File access');
    expect(markup).toContain('Role prompt');
  });

  it('renders a created team with its fresh member sessions', () => {
    const markup = renderToStaticMarkup(<TeamOverview team={team} />);

    expect(markup).toContain('Product Builder');
    expect(markup).toContain('Concurrency 1');
    expect(markup).toContain('/project');
    expect(markup).toContain('leader');
    expect(markup).toContain('fake · default model');
    expect(markup).toContain('session-1');
    expect(markup).not.toContain('Delete team');
  });

  it('shows worktree metadata for isolated members', () => {
    const markup = renderToStaticMarkup(<TeamOverview team={isolatedTeam} />);

    expect(markup).toContain('read/write');
    expect(markup).toContain('/workspace/.agent-team-worktrees/team-1/backend-coder');
    expect(markup).toContain('agent-team/team-1/backend-coder');
  });

  it('renders the team delete action in the sidebar list', () => {
    const markup = renderToStaticMarkup(
      <TeamList teams={[team]} selectedId="team-1" onSelect={() => {}} onDelete={() => {}} />,
    );

    expect(markup).toContain('Product Builder');
    expect(markup).toContain('Delete Product Builder');
    expect(markup).toContain('team-list-delete');
  });

  it('validates max parallel members as a 1 to 8 integer', () => {
    expect(parseParallelMembers('1')).toBe(1);
    expect(parseParallelMembers('8')).toBe(8);
    expect(parseParallelMembers('')).toBeNull();
    expect(parseParallelMembers('0')).toBeNull();
    expect(parseParallelMembers('9')).toBeNull();
    expect(parseParallelMembers('2.5')).toBeNull();
    expect(parseParallelMembers('abc')).toBeNull();
  });
});
