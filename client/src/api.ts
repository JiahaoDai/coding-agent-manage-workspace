import type {
  AgentId,
  CapabilityResult,
  CreateTeamInput,
  FsEntry,
  Message,
  ModelOption,
  ResumableSession,
  SessionRecord,
  TeamWithMembers,
} from './types';

export async function listAgents(): Promise<AgentId[]> {
  const res = await fetch('/api/agents');
  return res.json();
}

export async function listAgentModels(agent: AgentId, cwd: string): Promise<CapabilityResult<ModelOption[]>> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/models?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `agent models failed: ${res.status}`);
  }
  return res.json();
}

/** The file tree's root directory (configurable on the server; default ~). */
export async function getFsRoot(): Promise<{ root: string; name: string }> {
  const res = await fetch('/api/fs/root');
  if (!res.ok) throw new Error(`fs root failed: ${res.status}`);
  return res.json();
}

/** One level of the file tree, relative to the root ('' = the root itself). */
export async function listFsChildren(path: string): Promise<FsEntry[]> {
  const res = await fetch(`/api/fs/children?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `fs children failed: ${res.status}`);
  }
  const body = (await res.json()) as { entries: FsEntry[] };
  return body.entries;
}

export async function listSessions(): Promise<SessionRecord[]> {
  const res = await fetch('/api/sessions');
  return res.json();
}

export async function listTeams(): Promise<TeamWithMembers[]> {
  const res = await fetch('/api/teams');
  if (!res.ok) throw new Error(`teams failed: ${res.status}`);
  return res.json();
}

export async function createTeam(input: CreateTeamInput): Promise<TeamWithMembers> {
  const res = await fetch('/api/teams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `create team failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteTeam(teamId: string): Promise<void> {
  const res = await fetch(`/api/teams/${teamId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `delete team failed: ${res.status}`);
  }
}

export async function createSession(input: {
  cwd: string;
  agent: AgentId;
  name: string;
}): Promise<SessionRecord> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `create failed: ${res.status}`);
  }
  return res.json();
}

/** Send a message. The reply arrives asynchronously over the SSE stream. */
export async function sendMessage(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `send failed: ${res.status}`);
  }
}

export async function getSessionModels(sessionId: string): Promise<CapabilityResult<ModelOption[]>> {
  const res = await fetch(`/api/sessions/${sessionId}/models`);
  if (!res.ok) throw new Error(`models failed: ${res.status}`);
  return res.json();
}

export async function selectSessionModel(sessionId: string, model_id: string | null): Promise<SessionRecord> {
  const res = await fetch(`/api/sessions/${sessionId}/model`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `model selection failed: ${res.status}`);
  }
  return res.json();
}

/** A session's message history, read from the agent's native store at display time. */
export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `messages failed: ${res.status}`);
  }
  return res.json();
}

/** Soft-delete a session: removes the app's record; the agent's native session stays intact. */
export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `delete failed: ${res.status}`);
  }
}

/** Native sessions for a folder+agent that the app is not tracking — resume candidates. */
export async function listNativeSessions(
  cwd: string,
  agent: AgentId,
): Promise<ResumableSession[]> {
  const res = await fetch(
    `/api/sessions/native?cwd=${encodeURIComponent(cwd)}&agent=${encodeURIComponent(agent)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `list native failed: ${res.status}`);
  }
  return res.json();
}

/** Resume a native session: add an app record for it (after a soft delete, or one created outside the app). */
export async function resumeSession(input: {
  cwd: string;
  agent: AgentId;
  real_session_id: string;
  name?: string;
}): Promise<SessionRecord> {
  const res = await fetch('/api/sessions/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `resume failed: ${res.status}`);
  }
  return res.json();
}

/** Answer a pending permission request. The agent's turn only continues after this resolves. */
export async function respondPermission(
  sessionId: string,
  request_id: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request_id, decision }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `permission respond failed: ${res.status}`);
  }
}
