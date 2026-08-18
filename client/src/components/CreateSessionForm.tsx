import { useEffect, useState } from 'react';
import { createSession, importSession, listNativeSessions } from '../api';
import type { AgentId, ReimportableSession, SessionRecord } from '../types';

export function CreateSessionForm({
  agents,
  onCreated,
  onCancel,
}: {
  agents: AgentId[];
  onCreated: (session: SessionRecord) => void;
  onCancel: () => void;
}) {
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState<AgentId>('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Native sessions in this folder+agent the app isn't tracking (soft-deleted,
  // or created outside the app) — offered for re-import.
  const [importables, setImportables] = useState<ReimportableSession[]>([]);
  const [importingId, setImportingId] = useState<string | null>(null);

  const canLookup = cwd.trim() !== '' && agent !== '';

  useEffect(() => {
    let cancelled = false;
    if (!canLookup) {
      setImportables([]);
      return;
    }
    setImportables([]);
    void listNativeSessions(cwd.trim(), agent)
      .then((list) => {
        if (!cancelled) setImportables(list);
      })
      .catch(() => {
        // Best-effort: if the lookup fails (e.g. unknown agent) just show none.
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, agent, canLookup]);

  const canSubmit = cwd.trim() !== '' && agent !== '' && name.trim() !== '' && !submitting;

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const session = await createSession({ cwd: cwd.trim(), agent, name: name.trim() });
      onCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function handleImport(session: ReimportableSession) {
    setError(null);
    setImportingId(session.real_session_id);
    try {
      const imported = await importSession({
        cwd: cwd.trim(),
        agent,
        real_session_id: session.real_session_id,
        name: session.summary ?? session.real_session_id,
      });
      onCreated(imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setImportingId(null);
    }
  }

  return (
    <form
      className="create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <div className="create-form-header">
        <h2>New session</h2>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Refactor the auth flow"
          autoFocus
        />
      </label>

      <label className="field">
        <span className="field-label">Agent</span>
        <select value={agent} onChange={(event) => setAgent(event.target.value)}>
          <option value="" disabled>
            Select an agent
          </option>
          {agents.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">Directory</span>
        <input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="~/projects/my-app"
        />
      </label>

      {canLookup && importables.length > 0 && (
        <div className="reimport">
          <h3 className="reimport-title">Existing sessions in this folder</h3>
          <ul className="reimport-list">
            {importables.map((s) => (
              <li key={s.real_session_id} className="reimport-item">
                <span className="reimport-item-label" title={s.summary ?? s.real_session_id}>
                  {s.summary ?? s.real_session_id}
                </span>
                <button
                  type="button"
                  className="reimport-btn"
                  onClick={() => void handleImport(s)}
                  disabled={importingId !== null}
                >
                  {importingId === s.real_session_id ? 'Importing…' : 'Import'}
                </button>
              </li>
            ))}
          </ul>
          <p className="reimport-hint">
            Re-imports a session that was deleted here — the agent&apos;s original session is kept.
          </p>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="create-form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {submitting ? 'Creating…' : 'Create session'}
        </button>
      </div>
    </form>
  );
}
