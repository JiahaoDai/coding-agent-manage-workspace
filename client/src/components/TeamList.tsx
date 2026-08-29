import type { TeamWithMembers } from '../types';

export function TeamList({
  teams,
  selectedId,
  onSelect,
  onDelete,
  emptyLabel = 'No teams yet.',
}: {
  teams: TeamWithMembers[];
  selectedId: string | null;
  onSelect: (teamId: string) => void;
  onDelete: (teamId: string) => void;
  emptyLabel?: string;
}) {
  if (teams.length === 0) return <p className="session-empty">{emptyLabel}</p>;

  return (
    <nav className="team-list" aria-label="Teams">
      {teams.map((team) => (
        <div
          key={team.team_id}
          className={`team-list-item${team.team_id === selectedId ? ' is-selected' : ''}`}
        >
          <button
            type="button"
            className="team-list-item-main"
            onClick={() => onSelect(team.team_id)}
            aria-current={team.team_id === selectedId ? 'true' : undefined}
          >
            <span className="team-list-name">{team.name}</span>
            <span className="team-list-meta">
              {team.members.length} members · {team.status}
            </span>
          </button>
          <button
            type="button"
            className="session-item-delete team-list-delete"
            onClick={() => onDelete(team.team_id)}
            aria-label={`Delete ${team.name}`}
            title="Delete team and clean isolated worktrees when safe"
          >
            <TrashIcon />
          </button>
        </div>
      ))}
    </nav>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}
