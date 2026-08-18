import { useState } from 'react';
import { createSession } from '../api';
import type { AgentId, SessionRecord } from '../types';

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
