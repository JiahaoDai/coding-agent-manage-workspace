import { useEffect, useState } from 'react';
import { createTeam, getFsRoot } from '../api';
import type { AgentId, TeamMemberInput, TeamWithMembers } from '../types';
import { FileTree } from './FileTree';

const ROLE_TEMPLATES: Record<string, string> = {
  leader: 'Plan the work, assign tasks, review member results, and produce final answers.',
  'backend-coder': 'Implement backend changes, keep edits focused, and report concise results to leader.',
  reviewer: 'Review completed work for bugs, risks, missing tests, and regressions.',
  tester: 'Run or design tests, report failures, and summarize verification status.',
};

function defaultMember(role: string): TeamMemberInput {
  return {
    role,
    agent: '',
    model: null,
    responsibility_prompt: ROLE_TEMPLATES[role] ?? '',
  };
}

export function CreateTeamForm({
  agents,
  onCreated,
  onCancel,
}: {
  agents: AgentId[];
  onCreated: (team: TeamWithMembers) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [members, setMembers] = useState<TeamMemberInput[]>([defaultMember('leader')]);
  const [fsRoot, setFsRoot] = useState<{ root: string; name: string } | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void getFsRoot()
      .then(setFsRoot)
      .catch((err) => setFsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const canSubmit =
    name.trim() !== '' &&
    cwd.trim() !== '' &&
    members.length > 0 &&
    members.every((member) => member.role.trim() !== '' && member.agent !== '' && member.responsibility_prompt.trim() !== '') &&
    !submitting;

  function updateMember(index: number, patch: Partial<TeamMemberInput>) {
    setMembers((prev) => prev.map((member, i) => (i === index ? { ...member, ...patch } : member)));
  }

  function chooseRole(index: number, role: string) {
    updateMember(index, {
      role,
      responsibility_prompt: ROLE_TEMPLATES[role] ?? members[index].responsibility_prompt,
    });
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const team = await createTeam({
        name: name.trim(),
        cwd: cwd.trim(),
        members: members.map((member) => ({
          ...member,
          role: member.role.trim(),
          model: member.model && member.model.trim() !== '' ? member.model.trim() : null,
          responsibility_prompt: member.responsibility_prompt.trim(),
        })),
      });
      onCreated(team);
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
        <h2>New team</h2>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <label className="field">
        <span className="field-label">Team name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product Builder" autoFocus />
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

      <fieldset className="team-members-field">
        <legend className="field-label">Members</legend>
        {members.map((member, index) => (
          <div className="team-member-editor" key={index}>
            <div className="team-member-grid">
              <label className="field">
                <span className="field-label">Role</span>
                <select value={ROLE_TEMPLATES[member.role] ? member.role : 'custom'} onChange={(event) => chooseRole(index, event.target.value)}>
                  {Object.keys(ROLE_TEMPLATES).map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                  <option value="custom">custom</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Role name</span>
                <input value={member.role} onChange={(event) => updateMember(index, { role: event.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Agent</span>
                <select value={member.agent} onChange={(event) => updateMember(index, { agent: event.target.value })}>
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
                <span className="field-label">Model</span>
                <input
                  value={member.model ?? ''}
                  onChange={(event) => updateMember(index, { model: event.target.value })}
                  placeholder="agent default"
                />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Role prompt</span>
              <textarea
                value={member.responsibility_prompt}
                onChange={(event) => updateMember(index, { responsibility_prompt: event.target.value })}
                rows={3}
              />
            </label>
            {members.length > 1 && (
              <button type="button" className="btn btn-secondary" onClick={() => setMembers((prev) => prev.filter((_, i) => i !== index))}>
                Remove member
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn btn-secondary" onClick={() => setMembers((prev) => [...prev, defaultMember('backend-coder')])}>
          Add member
        </button>
      </fieldset>

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
          {submitting ? 'Starting…' : 'Create team'}
        </button>
      </div>
    </form>
  );
}
