import { useEffect, useState } from 'react';
import { createTeam, getFsRoot, listAgentModels } from '../api';
import type { AgentId, ModelOption, TeamMemberInput, TeamWithMembers } from '../types';
import { FileTree } from './FileTree';

const ROLE_TEMPLATES: Record<string, string> = {
  leader: 'Plan the work, assign tasks, review member results, and produce final answers.',
  'backend-coder': 'Implement backend changes, keep edits focused, and report concise results to leader.',
  reviewer: 'Review completed work for bugs, risks, missing tests, and regressions.',
  tester: 'Run or design tests, report failures, and summarize verification status.',
};

type ModelLookup = { loading: boolean; available: boolean; options: ModelOption[]; error?: string };

function defaultMember(role: string): TeamMemberInput {
  return {
    role,
    agent: '',
    model: null,
    responsibility_prompt: ROLE_TEMPLATES[role] ?? '',
    file_access: defaultFileAccess(role),
  };
}

function defaultFileAccess(role: string): TeamMemberInput['file_access'] {
  return role === 'reviewer' || role === 'tester' ? 'read_only' : 'read_write';
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
  const [worktreeIsolation, setWorktreeIsolation] = useState(false);
  const [maxParallelMembers, setMaxParallelMembers] = useState('1');
  const [members, setMembers] = useState<TeamMemberInput[]>([defaultMember('leader')]);
  const [fsRoot, setFsRoot] = useState<{ root: string; name: string } | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);
  const [modelLookups, setModelLookups] = useState<Record<string, ModelLookup>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const parsedMaxParallelMembers = parseParallelMembers(maxParallelMembers);
  const maxParallelMembersError = parallelMembersError(maxParallelMembers);

  useEffect(() => {
    void getFsRoot()
      .then(setFsRoot)
      .catch((err) => setFsError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (cwd.trim() === '') return;
    const uniqueAgents = [...new Set(members.map((member) => member.agent).filter((agent) => agent !== ''))];
    for (const agent of uniqueAgents) {
      const key = modelLookupKey(cwd.trim(), agent);
      if (modelLookups[key]) continue;
      setModelLookups((prev) => ({ ...prev, [key]: { loading: true, available: false, options: [] } }));
      void listAgentModels(agent, cwd.trim())
        .then((result) => {
          setModelLookups((prev) => ({
            ...prev,
            [key]: result.supported
              ? { loading: false, available: true, options: result.value }
              : { loading: false, available: false, options: [], error: result.reason },
          }));
        })
        .catch((err) => {
          setModelLookups((prev) => ({
            ...prev,
            [key]: {
              loading: false,
              available: false,
              options: [],
              error: err instanceof Error ? err.message : String(err),
            },
          }));
        });
    }
  }, [cwd, members, modelLookups]);

  const canSubmit =
    name.trim() !== '' &&
    cwd.trim() !== '' &&
    members.length > 0 &&
    parsedMaxParallelMembers !== null &&
    members.every((member) => member.role.trim() !== '' && member.agent !== '' && member.responsibility_prompt.trim() !== '') &&
    !submitting;

  function updateMember(index: number, patch: Partial<TeamMemberInput>) {
    setMembers((prev) => prev.map((member, i) => (i === index ? { ...member, ...patch } : member)));
  }

  function updateMemberAgent(index: number, agent: string) {
    updateMember(index, { agent, model: null });
  }

  function chooseRole(index: number, role: string) {
    updateMember(index, {
      role,
      responsibility_prompt: ROLE_TEMPLATES[role] ?? members[index].responsibility_prompt,
      file_access: defaultFileAccess(role),
    });
  }

  async function handleSubmit() {
    setError(null);
    if (parsedMaxParallelMembers === null) {
      setError('Max parallel members must be a number from 1 to 8.');
      return;
    }
    setSubmitting(true);
    try {
      const team = await createTeam({
        name: name.trim(),
        cwd: cwd.trim(),
        worktree_isolation: worktreeIsolation,
        max_parallel_members: parsedMaxParallelMembers,
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

      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={worktreeIsolation}
          onChange={(event) => setWorktreeIsolation(event.target.checked)}
        />
        <span>Use git worktree isolation for read/write members</span>
      </label>

      <label className="field">
        <span className="field-label">Max parallel members</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={maxParallelMembers}
          aria-invalid={maxParallelMembersError ? 'true' : undefined}
          onChange={(event) => {
            const next = event.target.value;
            if (/^\d*$/.test(next)) setMaxParallelMembers(next);
          }}
        />
        {maxParallelMembersError ? (
          <span className="field-help field-error">{maxParallelMembersError}</span>
        ) : (
          <span className="field-help">Use a number from 1 to 8.</span>
        )}
      </label>

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
                <select value={member.agent} onChange={(event) => updateMemberAgent(index, event.target.value)}>
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
                <select
                  value={member.model ?? ''}
                  onChange={(event) => updateMember(index, { model: event.target.value === '' ? null : event.target.value })}
                  disabled={member.agent === '' || cwd.trim() === '' || modelLookup(cwd, member.agent, modelLookups).loading}
                >
                  <option value="">
                    {modelSelectLabel(cwd, member.agent, modelLookup(cwd, member.agent, modelLookups))}
                  </option>
                  {modelLookup(cwd, member.agent, modelLookups).options.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.provider ? `${model.provider} · ${model.label}` : model.label}
                    </option>
                  ))}
                </select>
                {modelLookup(cwd, member.agent, modelLookups).error && (
                  <span className="field-help">{modelLookup(cwd, member.agent, modelLookups).error}</span>
                )}
              </label>
              <label className="field">
                <span className="field-label">File access</span>
                <select
                  value={member.file_access}
                  onChange={(event) => updateMember(index, { file_access: event.target.value as TeamMemberInput['file_access'] })}
                >
                  <option value="read_only">Read only</option>
                  <option value="read_write">Read/write</option>
                </select>
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

export function parseParallelMembers(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) return null;
  return parsed;
}

function parallelMembersError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter a number from 1 to 8.';
  if (!/^\d+$/.test(trimmed)) return 'Use digits only.';
  if (parseParallelMembers(trimmed) === null) return 'Maximum is 8.';
  return null;
}

function modelLookupKey(cwd: string, agent: string): string {
  return `${cwd}\n${agent}`;
}

function modelLookup(cwd: string, agent: string, lookups: Record<string, ModelLookup>): ModelLookup {
  if (cwd.trim() === '' || agent === '') return { loading: false, available: false, options: [] };
  return lookups[modelLookupKey(cwd.trim(), agent)] ?? { loading: false, available: false, options: [] };
}

function modelSelectLabel(cwd: string, agent: string, lookup: ModelLookup): string {
  if (cwd.trim() === '') return 'Select a directory first';
  if (agent === '') return 'Select an agent first';
  if (lookup.loading) return 'Loading models...';
  if (lookup.available && lookup.options.length > 0) return 'Agent default';
  return 'Agent default';
}
