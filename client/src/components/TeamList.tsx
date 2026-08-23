import type { TeamWithMembers } from '../types';

export function TeamList({
  teams,
  selectedId,
  onSelect,
}: {
  teams: TeamWithMembers[];
  selectedId: string | null;
  onSelect: (teamId: string) => void;
}) {
  if (teams.length === 0) return null;

  return (
    <nav className="team-list" aria-label="Teams">
      <h3 className="session-group-title">Teams</h3>
      {teams.map((team) => (
        <button
          type="button"
          key={team.team_id}
          className={`team-list-item${team.team_id === selectedId ? ' is-selected' : ''}`}
          onClick={() => onSelect(team.team_id)}
          aria-current={team.team_id === selectedId ? 'true' : undefined}
        >
          <span className="team-list-name">{team.name}</span>
          <span className="team-list-meta">
            {team.members.length} members · {team.status}
          </span>
        </button>
      ))}
    </nav>
  );
}
