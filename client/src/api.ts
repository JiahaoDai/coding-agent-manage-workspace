import type { AgentId, FsEntry, ResumableSession, SessionRecord } from './types';

export async function listAgents(): Promise<AgentId[]> {
  const res = await fetch('/api/agents');
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
