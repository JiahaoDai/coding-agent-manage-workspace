import type { AgentId, ReimportableSession, SessionRecord } from './types';

export async function listAgents(): Promise<AgentId[]> {
  const res = await fetch('/api/agents');
  return res.json();
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

/** Native sessions for a folder+agent that the app is not tracking — re-import candidates. */
export async function listNativeSessions(
  cwd: string,
  agent: AgentId,
): Promise<ReimportableSession[]> {
  const res = await fetch(
    `/api/sessions/native?cwd=${encodeURIComponent(cwd)}&agent=${encodeURIComponent(agent)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `list native failed: ${res.status}`);
  }
  return res.json();
}

/** Re-import a native session into the app's list (after a soft delete, or one created outside the app). */
export async function importSession(input: {
  cwd: string;
  agent: AgentId;
  real_session_id: string;
  name?: string;
}): Promise<SessionRecord> {
  const res = await fetch('/api/sessions/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `import failed: ${res.status}`);
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
