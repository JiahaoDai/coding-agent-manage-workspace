import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AdapterRegistry } from './adapters/registry';
import type { SessionStore } from './db';
import { createFsTree, FsPathError, type FsTree } from './fs/tree';
import { PermissionBroker } from './permission';
import type { SseHub } from './sse';
import type { PromptHandlers } from '../shared/adapter';
import type { ResumableSession, SessionRecord } from '../shared/session';
import type { CreateTeamInput, TeamMemberInput, TeamMemberRecord, TeamRecord } from '../shared/team';

export interface AppDeps {
  store: SessionStore;
  adapters: AdapterRegistry;
  sse: SseHub;
  /** In-app file tree for choosing a working directory. Defaults to ~ (see createFsTree). */
  fs?: FsTree;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // One broker per app instance: pending permission requests resolve back into
  // whichever turn asked, so concurrent sessions can't cross-wire answers.
  const permissions = new PermissionBroker();
  const fs = deps.fs ?? createFsTree();

  app.get('/api/agents', (c) => c.json(deps.adapters.list()));

  app.get('/api/fs/root', (c) => c.json({ root: fs.root, name: fs.rootName() }));

  // One level of the file tree at a time (lazy). `path` is relative to the
  // tree root; '' means the root itself.
  app.get('/api/fs/children', (c) => {
    const path = c.req.query('path') ?? '';
    try {
      return c.json({ path, entries: fs.listChildren(path) });
    } catch (err) {
      if (err instanceof FsPathError) return c.json({ error: err.message }, 400);
      return c.json({ error: 'failed to list directory' }, 500);
    }
  });

  app.get('/api/sessions', (c) => c.json(deps.store.listVisibleSessions()));

  app.get('/api/teams', (c) => c.json(deps.store.listTeams()));

  app.get('/api/teams/:id', (c) => {
    const team = deps.store.getTeam(c.req.param('id'));
    return team ? c.json(team) : c.json({ error: 'team not found' }, 404);
  });

  app.post('/api/teams', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<CreateTeamInput> | null;
    const validation = validateCreateTeam(body);
    if ('error' in validation) return c.json({ error: validation.error }, 400);

    const { name, cwd, members } = validation.value;
    const now = Date.now();
    const team: TeamRecord = {
      team_id: randomUUID(),
      name,
      cwd,
      status: 'idle',
      max_parallel_members: 1,
      create_time: now,
      modify_time: now,
    };
    const sessions: SessionRecord[] = [];
    const teamMembers: TeamMemberRecord[] = [];

    try {
      for (const member of members) {
        const adapter = deps.adapters.get(member.agent);
        if (!adapter) return c.json({ error: `unknown agent: ${member.agent}` }, 400);

        const session_id = randomUUID();
        const { real_session_id } = await adapter.createSession(cwd, { name: `${name} / ${member.role}` });
        if (member.model !== null) {
          const selected = await adapter.setModel(real_session_id, cwd, member.model);
          if (!selected.supported) return c.json({ error: selected.reason }, 409);
        }

        await adapter.prompt(real_session_id, cwd, memberInitializationPrompt(member), initializationHandlers());

        sessions.push({
          session_id,
          coding_agent: member.agent,
          real_session_id,
          name: `${name} / ${member.role}`,
          cwd,
          status: 'completed',
          model: member.model,
          last_error: null,
          create_time: now,
          modify_time: now,
        });
        teamMembers.push({
          member_id: randomUUID(),
          team_id: team.team_id,
          role: member.role,
          coding_agent: member.agent,
          session_id,
          model: member.model,
          responsibility_prompt: member.responsibility_prompt,
          status: 'idle',
          current_delivery_id: null,
          create_time: now + teamMembers.length,
          modify_time: now + teamMembers.length,
        });
      }

      for (const session of sessions) deps.store.insert(session);
      deps.store.insertTeam(team, teamMembers);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
    }

    return c.json(deps.store.getTeam(team.team_id), 201);
  });

  app.post('/api/sessions', async (c) => {
    const body = (await c.req.json()) as { cwd?: unknown; agent?: unknown; name?: unknown } | null;
    const { cwd, agent, name } = body ?? {};

    if (typeof cwd !== 'string' || cwd === '') return c.json({ error: 'cwd is required' }, 400);
    if (typeof agent !== 'string' || agent === '') return c.json({ error: 'agent is required' }, 400);
    if (typeof name !== 'string' || name === '') return c.json({ error: 'name is required' }, 400);

    const adapter = deps.adapters.get(agent);
    if (!adapter) return c.json({ error: `unknown agent: ${agent}` }, 400);

    const { real_session_id } = await adapter.createSession(cwd, { name });
    const now = Date.now();
    const session: SessionRecord = {
      session_id: randomUUID(),
      coding_agent: agent,
      real_session_id,
      name,
      cwd,
      status: 'completed',
      model: null,
      last_error: null,
      create_time: now,
      modify_time: now,
    };

    deps.store.insert(session);
    deps.sse.broadcast({ type: 'session_created', session_id: session.session_id, session });

    return c.json(session, 201);
  });

  // Soft delete: remove the app's own record only. The agent's native session
  // is deliberately left in place so it can be re-imported later (design §6.4) —
  // the adapter is never asked to delete anything.
  app.delete('/api/sessions/:id', (c) => {
    const session_id = c.req.param('id');
    const session = deps.store.get(session_id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    if (deps.store.isTeamMemberSession(session_id)) {
      return c.json({ error: 'team member sessions are managed by their team' }, 409);
    }

    deps.store.delete(session_id);
    deps.sse.broadcast({ type: 'session_removed', session_id });
    return c.json({ ok: true });
  });

  // Read a session's message history from the agent's native store at display
  // time (design §4: bodies never live in SQLite). The client calls this when a
  // session is selected, so a refresh repopulates the view from the native store.
  app.get('/api/sessions/:id/messages', async (c) => {
    const session_id = c.req.param('id');
    const session = deps.store.get(session_id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const adapter = deps.adapters.get(session.coding_agent);
    if (!adapter) return c.json({ error: `unknown agent: ${session.coding_agent}` }, 400);

    const messages = await adapter.getMessages(session.real_session_id, session.cwd);
    return c.json(messages);
  });

  // Native sessions a folder already has for an agent, minus the ones the app is
  // tracking. These are the resume candidates: soft-deleted sessions still live
  // in the agent's store under the same cwd, and so do sessions created outside
  // the app.
  app.get('/api/sessions/native', async (c) => {
    const cwd = c.req.query('cwd') ?? '';
    const agent = c.req.query('agent') ?? '';
    if (!cwd) return c.json({ error: 'cwd is required' }, 400);
    if (!agent) return c.json({ error: 'agent is required' }, 400);

    const adapter = deps.adapters.get(agent);
    if (!adapter) return c.json({ error: `unknown agent: ${agent}` }, 400);

    const native = await adapter.listSessions(cwd);
    const tracked = new Set(
      deps.store
        .list()
        .filter((s) => s.coding_agent === agent)
        .map((s) => s.real_session_id),
    );
    const candidates: ResumableSession[] = native
      .filter((n) => !tracked.has(n.real_session_id))
      .map((n) => ({ ...n, coding_agent: agent, cwd }));
    return c.json(candidates);
  });

  // Resume: create a record pointing at a native session the app already knows
  // how to talk to (soft-deleted, or created outside the app). No new native
  // session is created — the agent's native session is opened so its history is
  // continued. The name is taken from the request, or prefilled from the native
  // summary when omitted.
  app.post('/api/sessions/resume', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      cwd?: unknown;
      agent?: unknown;
      real_session_id?: unknown;
      name?: unknown;
    } | null;
    const cwd = body?.cwd;
    const agent = body?.agent;
    const real_session_id = body?.real_session_id;

    if (typeof cwd !== 'string' || cwd === '') return c.json({ error: 'cwd is required' }, 400);
    if (typeof agent !== 'string' || agent === '') return c.json({ error: 'agent is required' }, 400);
    if (typeof real_session_id !== 'string' || real_session_id === '') {
      return c.json({ error: 'real_session_id is required' }, 400);
    }

    const adapter = deps.adapters.get(agent);
    if (!adapter) return c.json({ error: `unknown agent: ${agent}` }, 400);

    // The native session must actually exist in this folder.
    const native = (await adapter.listSessions(cwd)).find((n) => n.real_session_id === real_session_id);
    if (!native) return c.json({ error: 'native session not found' }, 404);

    // Guard against resuming a session the app already tracks: one native
    // session, one app record.
    const already = deps.store
      .list()
      .some((s) => s.coding_agent === agent && s.real_session_id === real_session_id);
    if (already) return c.json({ error: 'session already imported' }, 409);

    // Open the native session so its history continues (a no-op for the fake
    // adapters; the real adapters do the actual resume here).
    await adapter.openSession(real_session_id, cwd);

    const name =
      typeof body?.name === 'string' && body.name.trim() !== ''
        ? body.name.trim()
        : (native.summary ?? real_session_id);

    const now = Date.now();
    const session: SessionRecord = {
      session_id: randomUUID(),
      coding_agent: agent,
      real_session_id,
      name,
      cwd,
      status: 'completed',
      model: null,
      last_error: null,
      create_time: now,
      modify_time: now,
    };

    deps.store.insert(session);
    deps.sse.broadcast({ type: 'session_created', session_id: session.session_id, session });

    return c.json(session, 201);
  });

  app.get('/api/sessions/:id/models', async (c) => {
    const session = deps.store.get(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    const adapter = deps.adapters.get(session.coding_agent);
    if (!adapter) return c.json({ error: `unknown agent: ${session.coding_agent}` }, 400);
    return c.json(await adapter.listModels(session.cwd));
  });

  app.post('/api/sessions/:id/model', async (c) => {
    const session_id = c.req.param('id');
    const session = deps.store.get(session_id);
    if (!session) return c.json({ error: 'session not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { model_id?: unknown } | null;
    const model_id = body?.model_id;
    if (model_id !== null && typeof model_id !== 'string') return c.json({ error: 'model_id must be a string or null' }, 400);
    const adapter = deps.adapters.get(session.coding_agent);
    if (!adapter) return c.json({ error: `unknown agent: ${session.coding_agent}` }, 400);
    try {
      const result = await adapter.setModel(session.real_session_id, session.cwd, model_id);
      if (!result.supported) return c.json({ error: result.reason }, 409);
      deps.store.updateModel(session_id, model_id);
      return c.json(deps.store.get(session_id)!);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
    }
  });

  // Send a message and stream the agent's reply downstream over SSE. The turn's
  // status is driven here: running while the adapter streams, completed on
  // resolve, error on reject. Events are tagged with the session id so the
  // client routes them to the right window.
  app.post('/api/sessions/:id/message', async (c) => {
    const session_id = c.req.param('id');
    const session = deps.store.get(session_id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = body?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      return c.json({ error: 'text is required' }, 400);
    }

    const adapter = deps.adapters.get(session.coding_agent);
    if (!adapter) return c.json({ error: `unknown agent: ${session.coding_agent}` }, 400);

    const handlers: PromptHandlers = {
      onTextDelta: (delta) => deps.sse.broadcast({ type: 'text_delta', session_id, text: delta }),
      onToolCallStart: (tool_call_id, name, input) =>
        deps.sse.broadcast({ type: 'tool_call_start', session_id, tool_call_id, name, input }),
      onToolCallEnd: (tool_call_id) =>
        deps.sse.broadcast({ type: 'tool_call_end', session_id, tool_call_id }),
      onThinkingDelta: (delta) => deps.sse.broadcast({ type: 'thinking_delta', session_id, text: delta }),
      onStatusNote: (text) => deps.sse.broadcast({ type: 'status_note', session_id, text }),
      onStatusChange: (status) => {
        // The server sets `running` at turn start, so an adapter reporting the
        // same status again must not double-write or double-broadcast.
        const current = deps.store.get(session_id);
        if (current && current.status === status) return;
        deps.store.updateStatus(session_id, status);
        deps.sse.broadcast({ type: 'status_change', session_id, status });
      },
      // Interactive permission confirmation: surface the request over SSE and
      // hold the adapter's promise until the user answers via POST
      // /api/sessions/:id/permission. Never auto-allow — every unapproved tool
      // must round-trip through the user.
      onPermissionRequest: (request_id, tool_name, input) => {
        deps.sse.broadcast({ type: 'permission_request', session_id, request_id, tool_name, input });
        return permissions.request(session_id, request_id);
      },
    };

    deps.store.updateStatus(session_id, 'running');
    deps.sse.broadcast({ type: 'status_change', session_id, status: 'running' });

    try {
      await adapter.prompt(session.real_session_id, session.cwd, text, handlers);
      // If the adapter didn't report a terminal status itself, mark completed.
      const current = deps.store.get(session_id);
      if (current && current.status === 'running') {
        deps.store.updateStatus(session_id, 'completed');
        deps.sse.broadcast({ type: 'status_change', session_id, status: 'completed' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.store.recordError(session_id, message);
      deps.sse.broadcast({ type: 'status_change', session_id, status: 'error' });
      deps.sse.broadcast({
        type: 'error',
        session_id,
        message,
      });
    }

    return c.json({ ok: true }, 202);
  });

  // Answer a pending permission request. The broker's promise is what the
  // adapter is awaiting, so resolving it unblocks the turn with the user's
  // decision (or lets the agent see the denial and adjust).
  app.post('/api/sessions/:id/permission', async (c) => {
    const session_id = c.req.param('id');
    const session = deps.store.get(session_id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const body = (await c.req.json().catch(() => null)) as {
      request_id?: unknown;
      decision?: unknown;
    } | null;
    const request_id = body?.request_id;
    const decision = body?.decision;

    if (typeof request_id !== 'string' || request_id === '') {
      return c.json({ error: 'request_id is required' }, 400);
    }
    if (decision !== 'allow' && decision !== 'deny') {
      return c.json({ error: 'decision must be allow or deny' }, 400);
    }

    // Scoped to the session: a request id that is unknown, already answered,
    // or belongs to another session must not resolve this turn.
    if (!permissions.resolve(session_id, request_id, decision)) {
      return c.json({ error: 'unknown or expired permission request' }, 404);
    }

    deps.sse.broadcast({ type: 'permission_response', session_id, request_id, decision });
    return c.json({ ok: true });
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      deps.sse.add(stream);
      // Stay open until the client disconnects; the hub removes the stream on abort.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });

  return app;
}

function validateCreateTeam(
  body: Partial<CreateTeamInput> | null,
): { value: CreateTeamInput } | { error: string } {
  if (!body || typeof body.name !== 'string' || body.name.trim() === '') return { error: 'name is required' };
  if (typeof body.cwd !== 'string' || body.cwd.trim() === '') return { error: 'cwd is required' };
  if (!Array.isArray(body.members) || body.members.length === 0) return { error: 'members are required' };

  const roles = new Set<string>();
  const members: TeamMemberInput[] = [];
  for (const raw of body.members) {
    if (!raw || typeof raw !== 'object') return { error: 'member must be an object' };
    const member = raw as Partial<TeamMemberInput>;
    if (typeof member.role !== 'string' || member.role.trim() === '') return { error: 'member role is required' };
    if (typeof member.agent !== 'string' || member.agent.trim() === '') return { error: 'member agent is required' };
    if (member.model !== null && member.model !== undefined && typeof member.model !== 'string') {
      return { error: 'member model must be a string or null' };
    }
    if (typeof member.responsibility_prompt !== 'string' || member.responsibility_prompt.trim() === '') {
      return { error: 'member responsibility_prompt is required' };
    }
    const role = member.role.trim();
    if (roles.has(role)) return { error: `duplicate member role: ${role}` };
    roles.add(role);
    members.push({
      role,
      agent: member.agent.trim(),
      model: member.model ?? null,
      responsibility_prompt: member.responsibility_prompt.trim(),
    });
  }
  if (!roles.has('leader')) return { error: 'team requires a leader member' };

  return { value: { name: body.name.trim(), cwd: body.cwd.trim(), members } };
}

function memberInitializationPrompt(member: TeamMemberInput): string {
  return [
    `You are ${member.role} in an agent team.`,
    '',
    'Your role:',
    member.responsibility_prompt,
    '',
    'Collaboration rules:',
    '- You receive tasks from the team orchestrator.',
    '- Treat each incoming delivery as the next task in this same team session.',
    '- Do not assume a previous task should be repeated unless the new delivery says so.',
    '- Report results concisely for the leader.',
    '',
    'Output format:',
    '- RESULT: ...',
    '- NEED_INFO: ...',
    '- MESSAGE_TO reviewer: ...',
    '- PROPOSAL: ...',
    '- FAILED: ...',
  ].join('\n');
}

function initializationHandlers(): PromptHandlers {
  return {
    onTextDelta: () => {},
    onToolCallStart: () => {},
    onToolCallEnd: () => {},
    onThinkingDelta: () => {},
    onStatusNote: () => {},
    onStatusChange: () => {},
    onPermissionRequest: async (_request_id, tool_name) => {
      throw new Error(`team member initialization requested permission for ${tool_name}`);
    },
  };
}
