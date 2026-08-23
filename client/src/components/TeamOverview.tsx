import type { TeamWithMembers } from '../types';

export function TeamOverview({ team }: { team: TeamWithMembers }) {
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
        <span className="team-status">{team.status}</span>
      </div>

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
