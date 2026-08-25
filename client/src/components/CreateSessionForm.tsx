import { useEffect, useState } from 'react';
import { createSession, getFsRoot, listNativeSessions, resumeSession } from '../api';
import type { AgentId, ResumableSession, SessionRecord } from '../types';
import { FileTree } from './FileTree';

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
  // Native sessions in this folder+agent the app isn't tracking. The user can
  // resume one (continues its history) or start a brand-new session.
  const [resumable, setResumable] = useState<ResumableSession[]>([]);
  // real_session_id of the session being resumed, or null for a new session.
  const [resumeTarget, setResumeTarget] = useState<string | null>(null);
  // The file tree root (design §10): the directory is picked from the tree,
  // never typed.
  const [fsRoot, setFsRoot] = useState<{ root: string; name: string } | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);

  const canLookup = cwd.trim() !== '' && agent !== '';

  useEffect(() => {
    void getFsRoot()
      .then(setFsRoot)
      .catch((err) => setFsError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!canLookup) {
      setResumable([]);
      return;
    }
    setResumable([]);
    setResumeTarget(null);
    void listNativeSessions(cwd.trim(), agent)
      .then((list) => {
        if (!cancelled) setResumable(list);
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
      if (resumeTarget) {
        const target = resumable.find((s) => s.real_session_id === resumeTarget);
        const session = await resumeSession({
          cwd: cwd.trim(),
          agent,
          real_session_id: resumeTarget,
          name: name.trim() || (target?.summary ?? resumeTarget),
        });
        onCreated(session);
      } else {
        const session = await createSession({ cwd: cwd.trim(), agent, name: name.trim() });
        onCreated(session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function handlePickResume(session: ResumableSession) {
    setResumeTarget(session.real_session_id);
    // Prefill the editable name from the native summary (or first prompt).
    setName(session.summary ?? session.real_session_id);
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
        <span className="field-label">Agent</span>
        <select
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
          autoFocus
        >
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

      <div className="field">
        <span className="field-label">Directory</span>
        {fsError ? (
          <p className="error" role="alert">
            {fsError}
          </p>
        ) : fsRoot ? (
          <>
            <FileTree root={{ name: fsRoot.name, absolute: fsRoot.root }} onSelect={(entry) => setCwd(entry.absolute)} />
            <p className="directory-selected" title={cwd}>
              {cwd ? cwd : 'Click a folder to set the working directory.'}
            </p>
          </>
        ) : (
          <p className="file-node-loading">Loading…</p>
        )}
      </div>

      {canLookup && resumable.length > 0 && (
        <fieldset className="resume-options">
          <legend className="resume-options-title">Start from</legend>
          <label className={`resume-option${resumeTarget === null ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name="resume"
              checked={resumeTarget === null}
              onChange={() => setResumeTarget(null)}
            />
            <span className="resume-option-label">New session</span>
          </label>
          {resumable.map((s) => (
            <label
              key={s.real_session_id}
              className={`resume-option${resumeTarget === s.real_session_id ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="resume"
                checked={resumeTarget === s.real_session_id}
                onChange={() => handlePickResume(s)}
              />
              <span className="resume-option-label" title={s.summary ?? s.real_session_id}>
                {s.summary ?? s.real_session_id}
              </span>
              <span className="resume-option-tag">resume</span>
            </label>
          ))}
          <p className="resume-options-hint">
            Existing sessions in this folder — resume one to continue its history, or start fresh.
          </p>
        </fieldset>
      )}

      <label className="field">
        <span className="field-label">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={resumeTarget ? 'Resumed session name' : 'e.g. Refactor the auth flow'}
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
          {submitting
            ? 'Starting…'
            : resumeTarget
              ? 'Resume session'
              : 'Create session'}
        </button>
      </div>
    </form>
  );
}
