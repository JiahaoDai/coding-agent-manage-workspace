import type { TeamWithMembers } from '../types';

export function TeamOverview({
  team,
  deleteError,
}: {
  team: TeamWithMembers;
  deleteError?: string | null;
}) {
  return (
    <section className="team-overview" aria-labelledby="team-overview-title">
      <div className="team-overview-header">
        <div>
          <p className="team-overview-kicker">Agent team</p>
          <h2 id="team-overview-title">{team.name}</h2>
          <p className="team-overview-cwd" title={team.cwd}>
            {team.cwd}
          </p>
        </div>
        <div className="team-overview-statuses">
          <span className="team-status">parallel {team.max_parallel_members}</span>
          <span className="team-status">{team.status}</span>
        </div>
      </div>

      {deleteError && (
        <p className="error team-delete-error" role="alert">
          {deleteError}
        </p>
      )}

      <div className="team-member-cards" aria-label="Team members">
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
            <p className="team-member-meta">
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
            <p className="team-member-prompt">{member.responsibility_prompt}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
