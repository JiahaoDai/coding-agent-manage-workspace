import type { PermissionRequest } from '../types';

/**
 * Modal shown when an agent wants to run a tool that needs the user's ok. It
 * displays the tool name and its arguments; Allow/Deny is the only way out —
 * there is no dismiss, because the agent's turn is paused on this decision.
 */
export function PermissionModal({
  request,
  sessionLabel,
  onDecision,
}: {
  request: PermissionRequest;
  /** Human-readable context for which session asked, e.g. "name · claude". */
  sessionLabel: string;
  onDecision: (decision: 'allow' | 'deny') => void;
}) {
  const team = request.team_context;
  return (
    <div className="permission-overlay" role="dialog" aria-modal="true" aria-labelledby="permission-title">
      <div className="permission-modal">
        <div className="permission-header">
          <span className="permission-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
              <path d="M12 8v4" />
              <path d="M12 15.5h.01" />
            </svg>
          </span>
          <div className="permission-heading">
            <h3 id="permission-title">Permission request</h3>
            <p className="permission-sub">
              <span className="permission-session">
                {team ? `${team.team_name} · ${team.member_role}` : sessionLabel}
              </span>{' '}
              wants to run a tool
            </p>
          </div>
        </div>

        {team && (
          <dl className="permission-context" aria-label="Team delivery context">
            <div>
              <dt>Team</dt>
              <dd>{team.team_name}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{team.run_id}</dd>
            </div>
            <div>
              <dt>Member</dt>
              <dd>{team.member_role}</dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd>{team.member_agent}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{`${sessionLabel} · ${team.session_id}`}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>{team.delivery_id}</dd>
            </div>
            <div className="permission-context-wide">
              <dt>CWD</dt>
              <dd>{team.cwd}</dd>
            </div>
          </dl>
        )}

        <div className="permission-tool">
          <span className="permission-tool-name">{request.tool_name}</span>
          <span className="permission-tool-args-label">Arguments</span>
        </div>
        <pre className="permission-args">{JSON.stringify(request.input, null, 2)}</pre>

        <div className="permission-actions">
          <button type="button" className="btn btn-secondary btn-deny" onClick={() => onDecision('deny')}>
            Deny
          </button>
          <button type="button" className="btn btn-primary btn-allow" onClick={() => onDecision('allow')}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
