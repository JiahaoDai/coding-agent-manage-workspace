import type { AgentId, SessionRecord } from './types';

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
