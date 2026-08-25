import { STATUS_LABEL } from '../labels';
import { agentOptions, DEFAULT_FILTERS, statusOptions, type SessionFilters } from '../sessionFilters';
import type { SessionRecord } from '../types';

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SearchIcon() {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/**
 * Search + agent/status filters for the session list. Lives inside the sidebar;
 * the filtered list is derived in the parent via `filterSessions`.
 */
export function SessionFiltersBar({
  sessions,
  filters,
  onChange,
}: {
  sessions: SessionRecord[];
  filters: SessionFilters;
  onChange: (filters: SessionFilters) => void;
}) {
  const agents = agentOptions(sessions);
  const active =
    filters.query.trim() !== '' || filters.agent !== '' || filters.status !== '';

  return (
    <div className="session-filters">
      <div className="session-search">
        <span className="session-search-icon">
          <SearchIcon />
        </span>
        <input
          type="text"
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          placeholder="Search name or folder…"
          aria-label="Search sessions by name or folder"
          spellCheck={false}
        />
        {active && (
          <button
            type="button"
            className="session-search-clear"
            onClick={() => onChange(DEFAULT_FILTERS)}
            aria-label="Clear search and filters"
          >
            <ClearIcon />
          </button>
        )}
      </div>
      <div className="session-filter-row">
        <select
          className="session-filter-select"
          value={filters.agent}
          onChange={(e) => onChange({ ...filters, agent: e.target.value })}
          aria-label="Filter by agent"
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
        <select
          className="session-filter-select"
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value as SessionFilters['status'] })}
          aria-label="Filter by status"
        >
          <option value="">All status</option>
          {statusOptions().map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
