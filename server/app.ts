import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AdapterRegistry } from './adapters/registry';
import type { SessionStore } from './db';
import { createFsTree, FsPathError, type FsTree } from './fs/tree';
import { PermissionBroker } from './permission';
import type { SseHub } from './sse';
import type { AgentAdapter, PromptHandlers } from '../shared/adapter';
import type { TeamPermissionContext, TeamStreamKind } from '../shared/events';
import type { ResumableSession, SessionRecord } from '../shared/session';
import type {
  CreateTeamInput,
  TeamDeliveryAttemptRecord,
  TeamDeliveryDependencyType,
  TeamMemberInput,
  TeamMemberRecord,
  TeamMessageDeliveryRecord,
  TeamMessageKind,
  TeamMessageRecord,
  TeamRecord,
  TeamRunRecord,
  TeamRunWithItems,
  TeamWithMembers,
} from '../shared/team';

export interface AppDeps {
  store: SessionStore;
  adapters: AdapterRegistry;
  sse: SseHub;
  /** In-app file tree for choosing a working directory. Defaults to ~ (see createFsTree). */
  fs?: FsTree;
  /** Delivery retry backoff in milliseconds. Defaults to 30s, then 60s. */
  deliveryRetryBackoffMs?: number[];
}

const DEFAULT_DELIVERY_RETRY_BACKOFF_MS = [30_000, 60_000];

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // One broker per app instance: pending permission requests resolve back into
  // whichever turn asked, so concurrent sessions can't cross-wire answers.
  const permissions = new PermissionBroker();
  const fs = deps.fs ?? createFsTree();

  app.get('/api/agents', (c) => c.json(deps.adapters.list()));

  app.get('/api/agents/:agent/models', async (c) => {
    const agent = c.req.param('agent');
    const cwd = c.req.query('cwd') ?? '';
    if (!cwd) return c.json({ error: 'cwd is required' }, 400);

    const adapter = deps.adapters.get(agent);
    if (!adapter) return c.json({ error: `unknown agent: ${agent}` }, 400);

    return c.json(await adapter.listModels(cwd));
  });

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

  app.get('/api/teams/:id/runs', (c) => {
    const team_id = c.req.param('id');
    const team = deps.store.getTeam(team_id);
    if (!team) return c.json({ error: 'team not found' }, 404);
    return c.json(deps.store.listTeamRuns(team_id));
  });

  app.delete('/api/teams/:id', (c) => {
    const removed = deps.store.deleteTeam(c.req.param('id'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'team not found' }, 404);
  });

  app.post('/api/teams/:id/runs', async (c) => {
    const team_id = c.req.param('id');
    const team = deps.store.getTeam(team_id);
    if (!team) return c.json({ error: 'team not found' }, 404);
    if (team.status === 'running') return c.json({ error: 'team is already running' }, 409);

    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = body?.text;
    if (typeof text !== 'string' || text.trim() === '') return c.json({ error: 'text is required' }, 400);

    const leader = team.members.find((member) => member.role === 'leader');
    if (!leader) return c.json({ error: 'team requires a leader member' }, 409);

    const session = deps.store.get(leader.session_id);
    if (!session) return c.json({ error: 'leader session not found' }, 404);

    const adapter = deps.adapters.get(session.coding_agent);
    if (!adapter) return c.json({ error: `unknown agent: ${session.coding_agent}` }, 400);

    const now = Date.now();
    if (team.status === 'waiting_user') {
      const user_message_id = randomUUID();
      const delivery_id = randomUUID();
      const resumed = deps.store.resumeWaitingTeamRun({
        team_id,
        leader_member_id: leader.member_id,
        user_message_id,
        delivery_id,
        content: text.trim(),
        now,
      });
      if (!resumed) return c.json({ error: 'team is not waiting for user input' }, 409);

      const user_message = resumed.messages.find((message) => message.message_id === user_message_id)!;
      const delivery = resumed.deliveries.find((item) => item.delivery_id === delivery_id)!;
      deps.sse.broadcast({ type: 'team_run_resumed', team_id, run: resumed.run, user_message, delivery });
      void runTeamOrchestrator({
        deps,
        permissions,
        team_id,
        run_id: resumed.run.run_id,
      });
      return c.json(resumed, 202);
    }

    const created = deps.store.createLeaderRun({
      run_id: randomUUID(),
      team_id,
      leader_member_id: leader.member_id,
      user_message_id: randomUUID(),
      delivery_id: randomUUID(),
      content: text.trim(),
      now,
    });
    const delivery = created.deliveries[0];
    const user_message = created.messages[0];

    deps.sse.broadcast({ type: 'team_run_created', team_id, run: created.run, user_message, delivery });

    void runLeaderOnlyDelivery({
      deps,
      permissions,
      adapter,
      team_name: team.name,
      team_id,
      cwd: team.cwd,
      leader,
      session,
      run: created.run,
      delivery_id: delivery.delivery_id,
      text: text.trim(),
      team_members: team.members,
    });

    return c.json(created, 202);
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
        if (!adapter) return c.json({ error: `unknown agent for member ${member.role}: ${member.agent}` }, 400);
        if (member.model !== null) {
          const models = await adapter.listModels(cwd);
          if (!models.supported) return c.json({ error: `model selection is unavailable for member ${member.role}: ${models.reason}` }, 409);
          if (!models.value.some((model) => model.id === member.model)) {
            return c.json(
              {
                error: `model is not available for member ${member.role} (${member.agent}): ${member.model}`,
                available_models: models.value,
              },
              422,
            );
          }
        }
      }

      for (const member of members) {
        const adapter = deps.adapters.get(member.agent)!;

        const session_id = randomUUID();
        const { real_session_id } = await adapter.createSession(cwd, { name: `${name} / ${member.role}` });
        if (member.model !== null) {
          const selected = await adapter.setModel(real_session_id, cwd, member.model);
          if (!selected.supported) return c.json({ error: `model selection failed for member ${member.role}: ${selected.reason}` }, 409);
        }

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
          initialized_at: null,
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
    const resolved = permissions.resolve(session_id, request_id, decision);
    if (!resolved) {
      return c.json({ error: 'unknown or expired permission request' }, 404);
    }

    deps.sse.broadcast({ type: 'permission_response', session_id, request_id, decision, team_context: resolved.context });
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

async function runLeaderOnlyDelivery({
  deps,
  permissions,
  adapter,
  team_name,
  team_id,
  cwd,
  leader,
  session,
  run,
  delivery_id,
  text,
  team_members,
}: {
  deps: AppDeps;
  permissions: PermissionBroker;
  adapter: AgentAdapter;
  team_name: string;
  team_id: string;
  cwd: string;
  leader: TeamMemberRecord;
  session: SessionRecord;
  run: TeamRunRecord;
  delivery_id: string;
  text: string;
  team_members: TeamWithMembers['members'];
}): Promise<void> {
  const output: string[] = [];
  const started = deps.store.startTeamDeliveryAttempt(delivery_id);
  if (!started) {
    deps.store.updateTeamStatus(team_id, 'error');
    deps.store.recordError(session.session_id, 'leader delivery was not pending');
    deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'error' });
    return;
  }
  const attempt = started.attempt;
  const broadcastLeaderText = (text: string, stream_kind: TeamStreamKind = 'text', stream_label?: string) =>
    broadcastTeamTextDelta({
      deps,
      team_id,
      run_id: run.run_id,
      delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      text,
      stream_kind,
      stream_label,
  });

  deps.store.updateTeamMemberStatus(leader.member_id, 'running', delivery_id);
  deps.store.updateStatus(session.session_id, 'running');
  deps.sse.broadcast({
    type: 'team_delivery_status_change',
    team_id,
    run_id: run.run_id,
    delivery_id,
    attempt_id: attempt.attempt_id,
    member_id: leader.member_id,
    status: 'running',
  });
  deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'running' });

  const handlers: PromptHandlers = {
    onTextDelta: (delta) => {
      output.push(delta);
      broadcastLeaderText(delta);
    },
    onToolCallStart: (tool_call_id, name, input) => {
      broadcastLeaderText(`${name} ${tool_call_id} ${formatTeamToolInput(input)}`, 'tool', 'tool start');
    },
    onToolCallEnd: (tool_call_id) => {
      broadcastLeaderText(tool_call_id, 'tool', 'tool end');
    },
    onThinkingDelta: (delta) => {
      broadcastLeaderText(delta, 'thinking');
    },
    onStatusNote: (note) => {
      broadcastLeaderText(note, 'status', 'status');
    },
    onStatusChange: (status) => {
      const current = deps.store.get(session.session_id);
      if (current && current.status === status) return;
      deps.store.updateStatus(session.session_id, status);
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status });
    },
    onPermissionRequest: async (request_id, tool_name, input) => {
      deps.store.updateTeamMemberStatus(leader.member_id, 'waiting_permission', delivery_id);
      const team_context = teamPermissionContext({
        team_name,
        team_id,
        run_id: run.run_id,
        member: leader,
        session,
        delivery_id,
      });
      deps.sse.broadcast({ type: 'permission_request', session_id: session.session_id, request_id, tool_name, input, team_context });
      const decision = await permissions.request(session.session_id, request_id, team_context);
      deps.store.updateTeamMemberStatus(leader.member_id, 'running', delivery_id);
      return decision;
    },
  };

  try {
    const includeInitialization = leader.initialized_at === null;
    const activeLeader = includeInitialization ? deps.store.markTeamMemberInitialized(leader.member_id) ?? leader : leader;
    await adapter.prompt(
      session.real_session_id,
      cwd,
      leaderOnlyPrompt({ team_name, leader: activeLeader, includeInitialization, text, members: team_members }),
      handlers,
    );

    const rawOutput = output.join('');
    let outcome = parseLeaderOutcome(rawOutput, team_members);
    if ('error' in outcome && shouldRetryLeaderJson(rawOutput, outcome.error)) {
      const retryOutput: string[] = [];
      const current = deps.store.get(session.session_id);
      if (current && current.status !== 'running') {
        deps.store.updateStatus(session.session_id, 'running');
        deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'running' });
      }

      const retryHandlers: PromptHandlers = {
        ...handlers,
        onTextDelta: (delta) => {
          retryOutput.push(delta);
          broadcastLeaderText(delta);
        },
        onStatusNote: (note) => {
          retryOutput.push(note);
          broadcastLeaderText(note);
        },
      };
      await adapter.prompt(
        session.real_session_id,
        cwd,
        leaderJsonRetryPrompt(rawOutput, outcome.error),
        retryHandlers,
      );
      const retryOutcome = parseLeaderOutcome(retryOutput.join(''), team_members);
      if (!('error' in retryOutcome)) outcome = retryOutcome;
    }
    if ('error' in outcome) throw new Error(outcome.error);

    if (outcome.type === 'plan') {
      const planned = deps.store.createPlanDeliveries({
        team_id,
        run_id: run.run_id,
        leader_member_id: leader.member_id,
        plan_message_id: randomUUID(),
        summary: outcome.summary,
        assignments: outcome.assignments.map((assignment) => ({
          message_id: randomUUID(),
          delivery_id: assignment.delivery_id,
          to_member_id: assignment.to_member_id,
          content: assignmentContent(assignment),
          blocked: assignment.dependencies.length > 0,
          dependencies: assignment.dependencies,
        })),
        now: Date.now(),
      });

      deps.store.finishTeamDeliveryAttempt({ delivery_id, attempt_id: attempt.attempt_id, status: 'done', output: output.join(''), error: null });
      deps.store.updateTeamMemberStatus(leader.member_id, 'idle', null);
      const current = deps.store.get(session.session_id);
      if (current && current.status === 'running') {
        deps.store.updateStatus(session.session_id, 'completed');
        deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
      }
      deps.sse.broadcast({
        type: 'team_delivery_status_change',
        team_id,
        run_id: run.run_id,
        delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: leader.member_id,
        status: 'done',
      });
      deps.sse.broadcast({
        type: 'team_plan_created',
        team_id,
        run,
        plan_message: planned.plan_message,
        assignment_messages: planned.assignment_messages,
        deliveries: planned.deliveries,
        dependencies: planned.dependencies,
      });
      void runTeamOrchestrator({
        deps,
        permissions,
        team_id,
        run_id: run.run_id,
      });
      return;
    }

    if (outcome.type === 'need_user_input') {
      markLeaderWaitingForUser({
        deps,
        team_id,
        run_id: run.run_id,
        leader,
        session,
        delivery_id,
        attempt_id: attempt.attempt_id,
        attempt_output: output.join(''),
        question: outcome.question,
      });
      return;
    }

    const finalMessage: TeamMessageRecord = {
      message_id: randomUUID(),
      team_id,
      run_id: run.run_id,
      from_member_id: leader.member_id,
      from_kind: 'member',
      kind: 'final',
      content: outcome.result,
      create_time: Date.now(),
    };
    deps.store.insertTeamMessageRecord(finalMessage);
    deps.store.finishTeamDeliveryAttempt({ delivery_id, attempt_id: attempt.attempt_id, status: 'done', output: output.join(''), error: null });
    deps.store.updateTeamMemberStatus(leader.member_id, 'idle', null);
    deps.store.updateTeamStatus(team_id, 'idle');
    const completedRun = deps.store.finishTeamRun(run.run_id, 'completed');

    const current = deps.store.get(session.session_id);
    if (current && current.status === 'running') {
      deps.store.updateStatus(session.session_id, 'completed');
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
    }
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id,
      run_id: run.run_id,
      delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      status: 'done',
    });
    deps.sse.broadcast({ type: 'team_run_completed', team_id, run: completedRun, final_message: finalMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorMessage: TeamMessageRecord = {
      message_id: randomUUID(),
      team_id,
      run_id: run.run_id,
      from_member_id: leader.member_id,
      from_kind: 'system',
      kind: 'error',
      content: message,
      create_time: Date.now(),
    };

    deps.store.insertTeamMessageRecord(errorMessage);
    deps.store.finishTeamDeliveryAttempt({ delivery_id, attempt_id: attempt.attempt_id, status: 'failed', output: output.join(''), error: message });
    deps.store.updateTeamMemberStatus(leader.member_id, 'error', null);
    deps.store.updateTeamStatus(team_id, 'error');
    deps.store.recordError(session.session_id, message);
    const failedRun = deps.store.finishTeamRun(run.run_id, 'failed');

    deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'error' });
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id,
      run_id: run.run_id,
      delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      status: 'failed',
    });
    deps.sse.broadcast({ type: 'team_run_failed', team_id, run: failedRun, error_message: errorMessage });
  }
}

async function runTeamOrchestrator({
  deps,
  permissions,
  team_id,
  run_id,
}: {
  deps: AppDeps;
  permissions: PermissionBroker;
  team_id: string;
  run_id: string;
}): Promise<void> {
  for (;;) {
    const currentRun = deps.store.getTeamRun(run_id)?.run;
    if (!currentRun || currentRun.status !== 'running') break;

    const released = deps.store.releaseSatisfiedBlockedDeliveries(run_id);
    for (const delivery of released) {
      deps.sse.broadcast({
        type: 'team_delivery_status_change',
        team_id,
        run_id,
        delivery_id: delivery.delivery_id,
        member_id: delivery.to_member_id,
        status: 'pending',
      });
    }

    const claimed = claimNextDeliveryForCurrentWave(deps, run_id);
    if (!claimed) break;

    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id,
      run_id,
      delivery_id: claimed.delivery.delivery_id,
      attempt_id: claimed.attempt.attempt_id,
      member_id: claimed.member.member_id,
      status: 'running',
    });

    if (claimed.member.role === 'leader') {
      await runClaimedLeaderFollowUpDelivery({
        deps,
        permissions,
        delivery: claimed.delivery,
        attempt: claimed.attempt,
        message: claimed.message,
        leader: claimed.member,
      });
    } else {
      await runClaimedTeamDelivery({
        deps,
        permissions,
        delivery: claimed.delivery,
        attempt: claimed.attempt,
        message: claimed.message,
        member: claimed.member,
      });
    }
  }

  deps.store.completeRunIfNoOpenDeliveries(run_id);
}

function claimNextDeliveryForCurrentWave(deps: AppDeps, run_id: string) {
  const nonLeader = deps.store.claimNextRunnableTeamDelivery(run_id, { includeLeader: false });
  if (nonLeader) return nonLeader;

  // Keep leader follow-up behind the current worker/reviewer wave. Pending
  // retry-delayed deliveries can still produce output, so let their scheduled
  // orchestrator wake-up run before the leader consumes the inbox.
  if (deps.store.hasActiveNonLeaderTeamDeliveries(run_id)) return undefined;

  return deps.store.claimNextRunnableTeamDelivery(run_id);
}

function markLeaderWaitingForUser({
  deps,
  team_id,
  run_id,
  leader,
  session,
  delivery_id,
  attempt_id,
  attempt_output,
  question,
}: {
  deps: AppDeps;
  team_id: string;
  run_id: string;
  leader: TeamMemberRecord;
  session: SessionRecord;
  delivery_id: string;
  attempt_id?: string | null;
  attempt_output?: string | null;
  question: string;
}): void {
  if (attempt_id) {
    deps.store.finishTeamDeliveryAttempt({ delivery_id, attempt_id, status: 'done', output: attempt_output ?? null, error: null });
  }
  const waiting = deps.store.waitTeamRunForUser({
    team_id,
    run_id,
    leader_member_id: leader.member_id,
    delivery_id,
    question_message_id: randomUUID(),
    question,
    now: Date.now(),
  });

  const current = deps.store.get(session.session_id);
  if (current && current.status === 'running') {
    deps.store.updateStatus(session.session_id, 'completed');
    deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
  }
  deps.sse.broadcast({
    type: 'team_delivery_status_change',
    team_id,
    run_id,
    delivery_id,
    attempt_id,
    member_id: leader.member_id,
    status: 'done',
  });
  deps.sse.broadcast({
    type: 'team_run_waiting_user',
    team_id,
    run: waiting.run,
    question_message: waiting.question_message,
    delivery: waiting.delivery,
  });
}

async function runClaimedLeaderFollowUpDelivery({
  deps,
  permissions,
  delivery,
  attempt,
  message,
  leader,
}: {
  deps: AppDeps;
  permissions: PermissionBroker;
  delivery: TeamMessageDeliveryRecord;
  attempt: TeamDeliveryAttemptRecord;
  message: TeamMessageRecord;
  leader: TeamMemberRecord;
}): Promise<void> {
  const session = deps.store.get(leader.session_id);
  const adapter = session ? deps.adapters.get(session.coding_agent) : undefined;
  const fail = (error: string) => {
    const errorMessage: TeamMessageRecord = {
      message_id: randomUUID(),
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      from_member_id: leader.member_id,
      from_kind: 'system',
      kind: 'error',
      content: error,
      create_time: Date.now(),
    };

    deps.store.insertTeamMessageRecord(errorMessage);
    deps.store.finishTeamDeliveryAttempt({ delivery_id: delivery.delivery_id, attempt_id: attempt.attempt_id, status: 'failed', output: null, error });
    deps.store.updateTeamMemberStatus(leader.member_id, 'error', null);
    deps.store.updateTeamStatus(delivery.team_id, 'error');
    if (session) deps.store.recordError(session.session_id, error);
    const cancelled = deps.store.cancelOpenTeamDeliveries(delivery.run_id, delivery.delivery_id);
    const failedRun = deps.store.finishTeamRun(delivery.run_id, 'failed');

    if (session) deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'error' });
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      status: 'failed',
    });
    for (const cancelledDelivery of cancelled) {
      deps.sse.broadcast({
        type: 'team_delivery_status_change',
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: cancelledDelivery.delivery_id,
        member_id: cancelledDelivery.to_member_id,
        status: 'cancelled',
      });
    }
    deps.sse.broadcast({ type: 'team_run_failed', team_id: delivery.team_id, run: failedRun, error_message: errorMessage });
  };

  if (!session) {
    fail('leader session not found');
    return;
  }
  if (!adapter) {
    fail(`unknown agent: ${session.coding_agent}`);
    return;
  }

  const round = deps.store.advanceTeamRunRound(delivery.run_id);
  if (!round) {
    fail('team run not found');
    return;
  }
  if ('error' in round) {
    fail(round.error);
    return;
  }

  const output: string[] = [];
  const team = deps.store.getTeam(delivery.team_id);
  const broadcastLeaderText = (text: string, stream_kind: TeamStreamKind = 'text', stream_label?: string) =>
    broadcastTeamTextDelta({
      deps,
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      text,
      stream_kind,
      stream_label,
    });

  deps.store.updateStatus(session.session_id, 'running');
  deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'running' });
  const includeInitialization = leader.initialized_at === null;
  const activeLeader = includeInitialization ? deps.store.markTeamMemberInitialized(leader.member_id) ?? leader : leader;

  const handlers: PromptHandlers = {
    onTextDelta: (delta) => {
      output.push(delta);
      broadcastLeaderText(delta);
    },
    onToolCallStart: (tool_call_id, name, input) => {
      broadcastLeaderText(`${name} ${tool_call_id} ${formatTeamToolInput(input)}`, 'tool', 'tool start');
    },
    onToolCallEnd: (tool_call_id) => {
      broadcastLeaderText(tool_call_id, 'tool', 'tool end');
    },
    onThinkingDelta: (delta) => {
      broadcastLeaderText(delta, 'thinking');
    },
    onStatusNote: (note) => {
      broadcastLeaderText(note, 'status', 'status');
    },
    onStatusChange: (status) => {
      const current = deps.store.get(session.session_id);
      if (current && current.status === status) return;
      deps.store.updateStatus(session.session_id, status);
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status });
    },
    onPermissionRequest: async (request_id, tool_name, input) => {
      deps.store.updateTeamMemberStatus(leader.member_id, 'waiting_permission', delivery.delivery_id);
      const team_context = teamPermissionContext({
        team_name: team?.name ?? delivery.team_id,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        member: leader,
        session,
        delivery_id: delivery.delivery_id,
      });
      deps.sse.broadcast({ type: 'permission_request', session_id: session.session_id, request_id, tool_name, input, team_context });
      const decision = await permissions.request(session.session_id, request_id, team_context);
      deps.store.updateTeamMemberStatus(leader.member_id, 'running', delivery.delivery_id);
      return decision;
    },
  };

  try {
    const runItems = deps.store.getTeamRun(delivery.run_id);
    await adapter.prompt(
      session.real_session_id,
      session.cwd,
      leaderFollowUpPrompt({
        team_name: team?.name ?? delivery.team_id,
        leader: activeLeader,
        includeInitialization,
        message,
        members: team?.members ?? [leader],
        runItems,
      }),
      handlers,
    );

    const rawOutput = output.join('');
    let outcome = parseLeaderOutcome(rawOutput, team?.members ?? [leader]);
    if ('error' in outcome && shouldRetryLeaderJson(rawOutput, outcome.error)) {
      const retryOutput: string[] = [];
      const retryHandlers: PromptHandlers = {
        ...handlers,
        onTextDelta: (delta) => {
          retryOutput.push(delta);
          broadcastLeaderText(delta);
        },
        onStatusNote: (note) => {
          retryOutput.push(note);
          broadcastLeaderText(note);
        },
      };
      await adapter.prompt(
        session.real_session_id,
        session.cwd,
        leaderJsonRetryPrompt(rawOutput, outcome.error),
        retryHandlers,
      );
      const retryOutcome = parseLeaderOutcome(retryOutput.join(''), team?.members ?? [leader]);
      if (!('error' in retryOutcome)) outcome = retryOutcome;
    }
    if ('error' in outcome) throw new Error(outcome.error);

    if (outcome.type === 'plan') {
      const planned = deps.store.createPlanDeliveries({
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        leader_member_id: leader.member_id,
        plan_message_id: randomUUID(),
        summary: outcome.summary,
        assignments: outcome.assignments.map((assignment) => ({
          message_id: randomUUID(),
          delivery_id: assignment.delivery_id,
          to_member_id: assignment.to_member_id,
          content: assignmentContent(assignment),
          blocked: assignment.dependencies.length > 0,
          dependencies: assignment.dependencies,
        })),
        now: Date.now(),
      });

      deps.store.finishTeamDeliveryAttempt({ delivery_id: delivery.delivery_id, attempt_id: attempt.attempt_id, status: 'done', output: output.join(''), error: null });
      deps.store.updateTeamMemberStatus(leader.member_id, 'idle', null);
      const current = deps.store.get(session.session_id);
      if (current && current.status === 'running') {
        deps.store.updateStatus(session.session_id, 'completed');
        deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
      }
      deps.sse.broadcast({
        type: 'team_delivery_status_change',
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: leader.member_id,
        status: 'done',
      });
      deps.sse.broadcast({
        type: 'team_plan_created',
        team_id: delivery.team_id,
        run: deps.store.getTeamRun(delivery.run_id)!.run,
        plan_message: planned.plan_message,
        assignment_messages: planned.assignment_messages,
        deliveries: planned.deliveries,
        dependencies: planned.dependencies,
      });
      return;
    }

    if (outcome.type === 'need_user_input') {
      markLeaderWaitingForUser({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        leader,
        session,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        attempt_output: output.join(''),
        question: outcome.question,
      });
      return;
    }

    const finalMessage: TeamMessageRecord = {
      message_id: randomUUID(),
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      from_member_id: leader.member_id,
      from_kind: 'member',
      kind: 'final',
      content: outcome.result,
      create_time: Date.now(),
    };
    deps.store.insertTeamMessageRecord(finalMessage);
    deps.store.finishTeamDeliveryAttempt({ delivery_id: delivery.delivery_id, attempt_id: attempt.attempt_id, status: 'done', output: output.join(''), error: null });
    deps.store.updateTeamMemberStatus(leader.member_id, 'idle', null);
    deps.store.updateTeamStatus(delivery.team_id, 'idle');
    const cancelled = deps.store.cancelOpenTeamDeliveries(delivery.run_id, delivery.delivery_id);
    const completedRun = deps.store.finishTeamRun(delivery.run_id, 'completed');

    const current = deps.store.get(session.session_id);
    if (current && current.status === 'running') {
      deps.store.updateStatus(session.session_id, 'completed');
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
    }
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: leader.member_id,
      status: 'done',
    });
    for (const cancelledDelivery of cancelled) {
      deps.sse.broadcast({
        type: 'team_delivery_status_change',
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: cancelledDelivery.delivery_id,
        member_id: cancelledDelivery.to_member_id,
        status: 'cancelled',
      });
    }
    deps.sse.broadcast({ type: 'team_run_completed', team_id: delivery.team_id, run: completedRun, final_message: finalMessage });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function runClaimedTeamDelivery({
  deps,
  permissions,
  delivery,
  attempt,
  message,
  member,
}: {
  deps: AppDeps;
  permissions: PermissionBroker;
  delivery: TeamMessageDeliveryRecord;
  attempt: TeamDeliveryAttemptRecord;
  message: TeamMessageRecord;
  member: TeamMemberRecord;
}): Promise<void> {
  const session = deps.store.get(member.session_id);
  const adapter = session ? deps.adapters.get(session.coding_agent) : undefined;
  const output: string[] = [];
  const team = deps.store.getTeam(delivery.team_id);
  const fail = (error: string) => {
    const retry = retryableDeliveryFailure(deps, delivery, attempt, error);
    const finished = deps.store.finishTeamDeliveryAttempt({
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      status: 'failed',
      output: retry.shouldRetry ? null : output.join(''),
      error,
      retry_after: retry.retry_after,
    });
    deps.store.updateTeamMemberStatus(member.member_id, 'idle', null);
    if (session && !retry.shouldRetry) deps.store.recordError(session.session_id, error);
    if (session) {
      deps.store.updateStatus(session.session_id, retry.shouldRetry ? 'completed' : 'error');
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: retry.shouldRetry ? 'completed' : 'error' });
    }
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: member.member_id,
      status: retry.shouldRetry ? 'pending' : 'failed',
    });
    if (retry.shouldRetry) {
      scheduleTeamRetryOrchestrator(deps, permissions, delivery.team_id, delivery.run_id, retry.delay_ms);
      return;
    }

    const routed = routeMemberOutboundToLeader({
      deps,
      delivery: finished?.delivery ?? delivery,
      member,
      outbound: { kind: 'error', content: error },
    });
    if (routed) {
      deps.sse.broadcast({
        type: 'team_message_created',
        team_id: delivery.team_id,
        message: routed.message,
        delivery: routed.delivery,
      });
    }
  };

  if (!session) {
    fail('team member session not found');
    return;
  }
  if (!adapter) {
    fail(`unknown agent: ${session.coding_agent}`);
    return;
  }

  deps.store.updateStatus(session.session_id, 'running');
  deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'running' });
  const includeInitialization = member.initialized_at === null;
  const activeMember = includeInitialization ? deps.store.markTeamMemberInitialized(member.member_id) ?? member : member;

  const handlers: PromptHandlers = {
    onTextDelta: (delta) => {
      output.push(delta);
      broadcastTeamTextDelta({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: member.member_id,
        text: delta,
        stream_kind: 'text',
      });
    },
    onToolCallStart: (tool_call_id, name, input) => {
      broadcastTeamTextDelta({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: member.member_id,
        text: `${name} ${tool_call_id} ${formatTeamToolInput(input)}`,
        stream_kind: 'tool',
        stream_label: 'tool start',
      });
    },
    onToolCallEnd: (tool_call_id) => {
      broadcastTeamTextDelta({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: member.member_id,
        text: tool_call_id,
        stream_kind: 'tool',
        stream_label: 'tool end',
      });
    },
    onThinkingDelta: (delta) => {
      broadcastTeamTextDelta({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: member.member_id,
        text: delta,
        stream_kind: 'thinking',
      });
    },
    onStatusNote: (note) => {
      output.push(note);
      broadcastTeamTextDelta({
        deps,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        delivery_id: delivery.delivery_id,
        attempt_id: attempt.attempt_id,
        member_id: member.member_id,
        text: note,
        stream_kind: 'status',
        stream_label: 'status',
      });
    },
    onStatusChange: (status) => {
      const current = deps.store.get(session.session_id);
      if (current && current.status === status) return;
      deps.store.updateStatus(session.session_id, status);
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status });
    },
    onPermissionRequest: async (request_id, tool_name, input) => {
      deps.store.updateTeamMemberStatus(member.member_id, 'waiting_permission', delivery.delivery_id);
      const team_context = teamPermissionContext({
        team_name: team?.name ?? delivery.team_id,
        team_id: delivery.team_id,
        run_id: delivery.run_id,
        member,
        session,
        delivery_id: delivery.delivery_id,
      });
      deps.sse.broadcast({ type: 'permission_request', session_id: session.session_id, request_id, tool_name, input, team_context });
      const decision = await permissions.request(session.session_id, request_id, team_context);
      deps.store.updateTeamMemberStatus(member.member_id, 'running', delivery.delivery_id);
      return decision;
    },
  };

  try {
    const dependencies = deps.store.listDeliveryDependencies(delivery.delivery_id);
    const runItems = deps.store.getTeamRun(delivery.run_id);
    await adapter.prompt(
      session.real_session_id,
      session.cwd,
      deliveryPrompt({ delivery, message, member: activeMember, includeInitialization, dependencies, runItems }),
      handlers,
    );

    const outbound = parseMemberOutbound(output.join(''));
    const deliveryStatus = outbound.kind === 'error' ? 'failed' : 'done';
    deps.store.finishTeamDeliveryAttempt({
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      status: deliveryStatus,
      output: output.join(''),
      error: outbound.kind === 'error' ? outbound.content : null,
    });
    deps.store.updateTeamMemberStatus(member.member_id, 'idle', null);
    const routed = routeMemberOutboundToLeader({
      deps,
      delivery,
      member,
      outbound,
    });
    const current = deps.store.get(session.session_id);
    if (current && current.status === 'running') {
      deps.store.updateStatus(session.session_id, 'completed');
      deps.sse.broadcast({ type: 'status_change', session_id: session.session_id, status: 'completed' });
    }
    deps.sse.broadcast({
      type: 'team_delivery_status_change',
      team_id: delivery.team_id,
      run_id: delivery.run_id,
      delivery_id: delivery.delivery_id,
      attempt_id: attempt.attempt_id,
      member_id: member.member_id,
      status: deliveryStatus,
    });
    if (routed) {
      deps.sse.broadcast({
        type: 'team_message_created',
        team_id: delivery.team_id,
        message: routed.message,
        delivery: routed.delivery,
      });
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function routeMemberOutboundToLeader({
  deps,
  delivery,
  member,
  outbound,
}: {
  deps: AppDeps;
  delivery: TeamMessageDeliveryRecord;
  member: TeamMemberRecord;
  outbound: ParsedMemberOutbound;
}): { message: TeamMessageRecord; delivery: TeamMessageDeliveryRecord } | undefined {
  const team = deps.store.getTeam(delivery.team_id);
  const leader = team?.members.find((item) => item.role === 'leader');
  if (!leader || leader.member_id === member.member_id) return undefined;

  return deps.store.createMemberOutboundRoute({
    team_id: delivery.team_id,
    run_id: delivery.run_id,
    from_member_id: member.member_id,
    leader_member_id: leader.member_id,
    message_id: randomUUID(),
    delivery_id: randomUUID(),
    kind: outbound.kind,
    content: outbound.content,
    now: Date.now(),
  });
}

function broadcastTeamTextDelta({
  deps,
  team_id,
  run_id,
  delivery_id,
  attempt_id,
  member_id,
  text,
  stream_kind,
  stream_label,
}: {
  deps: AppDeps;
  team_id: string;
  run_id: string;
  delivery_id: string;
  attempt_id: string;
  member_id: string;
  text: string;
  stream_kind: TeamStreamKind;
  stream_label?: string;
}): void {
  deps.sse.broadcast({
    type: 'team_text_delta',
    team_id,
    run_id,
    delivery_id,
    attempt_id,
    member_id,
    text,
    stream_kind,
    stream_label,
  });
}

function retryableDeliveryFailure(
  deps: AppDeps,
  delivery: TeamMessageDeliveryRecord,
  attempt: TeamDeliveryAttemptRecord,
  error: string,
): { shouldRetry: true; retry_after: number; delay_ms: number } | { shouldRetry: false; retry_after: null; delay_ms: 0 } {
  if (!isRetryableDeliveryError(error)) return { shouldRetry: false, retry_after: null, delay_ms: 0 };
  if (attempt.attempt_number >= delivery.max_attempts) return { shouldRetry: false, retry_after: null, delay_ms: 0 };
  const backoff = deps.deliveryRetryBackoffMs ?? DEFAULT_DELIVERY_RETRY_BACKOFF_MS;
  const delay_ms = backoff[Math.max(0, attempt.attempt_number - 1)] ?? backoff[backoff.length - 1] ?? 0;
  return { shouldRetry: true, retry_after: Date.now() + delay_ms, delay_ms };
}

function isRetryableDeliveryError(error: string): boolean {
  const text = error.toLowerCase();
  if (
    /\b(billing|payment|required payment|quota exhausted|insufficient quota|api key|unauthorized|forbidden|permission denied|invalid|bad request|not found|missing file|missing path)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(timeout|timed out|etimedout|econnreset|network|rate limit|rate-limited|429|5\d\d|unavailable|temporar(?:y|ily)|transient)\b/.test(
    text,
  );
}

function scheduleTeamRetryOrchestrator(
  deps: AppDeps,
  permissions: PermissionBroker,
  team_id: string,
  run_id: string,
  delay_ms: number,
): void {
  setTimeout(() => {
    void runTeamOrchestrator({ deps, permissions, team_id, run_id });
  }, Math.max(0, delay_ms));
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

function memberInitializationPrompt(member: Pick<TeamMemberInput, 'role' | 'responsibility_prompt'>): string {
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

function formatTeamToolInput(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function teamPermissionContext({
  team_name,
  team_id,
  run_id,
  member,
  session,
  delivery_id,
}: {
  team_name: string;
  team_id: string;
  run_id: string;
  member: TeamMemberRecord;
  session: SessionRecord;
  delivery_id: string;
}): TeamPermissionContext {
  return {
    team_id,
    team_name,
    run_id,
    member_id: member.member_id,
    member_role: member.role,
    member_agent: member.coding_agent,
    delivery_id,
    session_id: session.session_id,
    cwd: session.cwd,
  };
}

function leaderOnlyPrompt({
  team_name,
  leader,
  includeInitialization,
  text,
  members,
}: {
  team_name: string;
  leader: TeamMemberRecord;
  includeInitialization: boolean;
  text: string;
  members: TeamWithMembers['members'];
}): string {
  const availableRoles = members.map((member) => member.role);
  const memberLines = members.map((member) => {
    const model = member.model ? `model=${member.model}` : 'model=agent-default';
    return `- ${member.role}: agent=${member.coding_agent}, ${model}, responsibility=${member.responsibility_prompt}`;
  });

  return [
    includeInitialization ? 'Member initialization (first delivery only):' : '',
    includeInitialization ? memberInitializationPrompt(leader) : '',
    includeInitialization ? '' : '',
    `Team: ${team_name}`,
    `Delivery target: ${leader.role}`,
    '',
    'Leader responsibility:',
    leader.responsibility_prompt,
    '',
    'User request:',
    text,
    '',
    'Decide whether to finish now, ask the user for clarification, or create a plan for other team members.',
    'Available member roles for assignments:',
    ...memberLines,
    '',
    `When returning a plan, each assignments[].to MUST be exactly one of: ${availableRoles.join(', ')}.`,
    'Do not invent roles or assign work to roles that are not listed above.',
    'If the work needs a role that is missing from the team, assign the closest existing role and mention the limitation in context.',
    'Return only one strict JSON object.',
    'Do not write prose, markdown, or explanations outside the JSON object.',
    'Escape every double quote inside JSON string values as \\".',
    'Escape every newline inside JSON string values as \\n; do not put literal line breaks inside a string value.',
    'Prefer single quotes or parentheses inside result text instead of raw double quotes.',
    '',
    'Final shape:',
    '{"type":"final","summary":"short summary","result":"final answer for the user"}',
    '',
    'Need user input shape:',
    '{"type":"need_user_input","question":"clear question for the user"}',
    '',
    'Plan shape:',
    '{"type":"plan","summary":"short summary","assignments":[{"id":"stable-id","to":"member-role","task":"task text","context":"useful context","depends_on":[],"dependency_type":"success"}]}',
  ].join('\n');
}

function leaderFollowUpPrompt({
  team_name,
  leader,
  includeInitialization,
  message,
  members,
  runItems,
}: {
  team_name: string;
  leader: TeamMemberRecord;
  includeInitialization: boolean;
  message: TeamMessageRecord;
  members: TeamWithMembers['members'];
  runItems: TeamRunWithItems | undefined;
}): string {
  const availableRoles = members.map((member) => member.role);
  const memberLines = members.map((member) => {
    const model = member.model ? `model=${member.model}` : 'model=agent-default';
    return `- ${member.role}: agent=${member.coding_agent}, ${model}, responsibility=${member.responsibility_prompt}`;
  });
  const memberById = new Map(members.map((member) => [member.member_id, member]));
  const sender = message.from_member_id ? memberById.get(message.from_member_id)?.role ?? message.from_member_id : message.from_kind;
  const busLines = (runItems?.messages ?? [])
    .filter((item) => item.message_id !== message.message_id)
    .map((item) => {
      const from = item.from_member_id ? memberById.get(item.from_member_id)?.role ?? item.from_member_id : item.from_kind;
      return `- ${item.kind} from ${from}: ${compactForPrompt(item.content)}`;
    });

  return [
    includeInitialization ? 'Member initialization (first delivery only):' : '',
    includeInitialization ? memberInitializationPrompt(leader) : '',
    includeInitialization ? '' : '',
    `Team: ${team_name}`,
    `Delivery target: ${leader.role}`,
    '',
    'Leader responsibility:',
    leader.responsibility_prompt,
    '',
    'New inbound team message: full content for this delivery',
    `Kind: ${message.kind}`,
    `From: ${sender}`,
    message.content,
    '',
    'Run message bus summary (orchestrator-generated excerpts; not full message bodies):',
    'If an item is marked as an orchestrator excerpt, do not treat that marker as evidence that the original worker output was truncated or incomplete.',
    busLines.length > 0 ? busLines.join('\n') : '- none',
    '',
    'Decide whether to finish now, ask the user for clarification, or create another plan for existing team members.',
    'Available member roles for assignments:',
    ...memberLines,
    '',
    `When returning a plan, each assignments[].to MUST be exactly one of: ${availableRoles.join(', ')}.`,
    'Do not invent roles or assign work to roles that are not listed above.',
    'Return only one strict JSON object.',
    'Do not write prose, markdown, or explanations outside the JSON object.',
    'Escape every double quote inside JSON string values as \\".',
    'Escape every newline inside JSON string values as \\n; do not put literal line breaks inside a string value.',
    '',
    'Final shape:',
    '{"type":"final","summary":"short summary","result":"final answer for the user"}',
    '',
    'Need user input shape:',
    '{"type":"need_user_input","question":"clear question for the user"}',
    '',
    'Plan shape:',
    '{"type":"plan","summary":"short summary","assignments":[{"id":"stable-id","to":"member-role","task":"task text","context":"useful context","depends_on":[],"dependency_type":"success"}]}',
  ].join('\n');
}

function leaderJsonRetryPrompt(previous: string, error: string): string {
  return [
    'Your previous leader response could not be parsed by JSON.parse.',
    `Parser error: ${error}`,
    '',
    'Rewrite the same intent as exactly one strict JSON object.',
    'Do not add prose, markdown fences, or comments.',
    'Allowed shapes:',
    '{"type":"final","summary":"short summary","result":"final answer for the user"}',
    '{"type":"need_user_input","question":"clear question for the user"}',
    '{"type":"plan","summary":"short summary","assignments":[{"id":"stable-id","to":"member-role","task":"task text","context":"useful context","depends_on":[],"dependency_type":"success"}]}',
    '',
    'Strict JSON reminders:',
    '- Escape every double quote inside string values as \\".',
    '- Escape every newline inside string values as \\n.',
    '- Use type "final", not "final answer".',
    '',
    'Previous response to rewrite:',
    previous,
  ].join('\n');
}

interface ParsedMemberOutbound {
  kind: Extract<TeamMessageKind, 'result' | 'review' | 'need_info' | 'proposal' | 'error'>;
  content: string;
}

function parseMemberOutbound(raw: string): ParsedMemberOutbound {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'result', content: 'Completed without an explicit result.' };

  const direct = trimmed.match(/^MESSAGE_TO\s+([A-Za-z0-9_-]+)\s*:\s*([\s\S]*)$/i);
  if (direct) {
    const target = direct[1].trim();
    const body = direct[2].trim();
    return {
      kind: 'proposal',
      content: [`Attempted message to ${target}. V1 routed it to leader for approval.`, body].filter(Boolean).join('\n\n'),
    };
  }

  const tagged = trimmed.match(/^(RESULT|REVIEW|NEED_INFO|PROPOSAL|FAILED)\s*:\s*([\s\S]*)$/i);
  if (!tagged) return { kind: 'result', content: trimmed };

  const content = tagged[2].trim() || 'No details provided.';
  switch (tagged[1].toUpperCase()) {
    case 'REVIEW':
      return { kind: 'review', content };
    case 'NEED_INFO':
      return { kind: 'need_info', content };
    case 'PROPOSAL':
      return { kind: 'proposal', content };
    case 'FAILED':
      return { kind: 'error', content };
    case 'RESULT':
    default:
      return { kind: 'result', content };
  }
}

interface ValidatedPlanAssignment {
  id: string;
  to: string;
  to_member_id: string;
  task: string;
  context: string;
  delivery_id: string;
  dependencies: Array<{ depends_on_delivery_id: string; dependency_type: TeamDeliveryDependencyType }>;
  depends_on: string[];
}

type LeaderOutcome =
  | { type: 'final'; summary: string; result: string }
  | { type: 'plan'; summary: string; assignments: ValidatedPlanAssignment[] }
  | { type: 'need_user_input'; question: string }
  | { error: string };

function parseLeaderOutcome(raw: string, members: TeamWithMembers['members']): LeaderOutcome {
  const parsed = parseLeaderJson(raw);
  if ('error' in parsed) return parsed;

  if (parsed.value.type === 'final') {
    if (typeof parsed.value.result !== 'string' || parsed.value.result.trim() === '') {
      return { error: 'leader final result is required' };
    }
    return {
      type: 'final',
      summary: typeof parsed.value.summary === 'string' ? parsed.value.summary : '',
      result: parsed.value.result.trim(),
    };
  }

  if (parsed.value.type === 'plan') return validateLeaderPlan(parsed.value, members);
  if (parsed.value.type === 'need_user_input') {
    const question = typeof parsed.value.question === 'string' ? parsed.value.question.trim() : '';
    if (!question) return { error: 'leader need_user_input question is required' };
    return { type: 'need_user_input', question };
  }

  return { error: 'leader response type must be final, plan, or need_user_input' };
}

function parseLeaderJson(raw: string): { value: Record<string, unknown> } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'leader response was empty' };

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (!fenced && jsonStart !== -1 && jsonEnd === -1) return { error: 'leader response was not valid JSON' };
  const candidate = fenced ? fenced[1].trim() : trimmed.slice(jsonStart, jsonEnd + 1);
  if (!candidate) return { error: 'leader response did not contain JSON' };

  try {
    const value = JSON.parse(candidate) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'leader JSON must be an object' };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    const repaired = repairLooseFinalJson(candidate);
    if (repaired) return { value: repaired };
    return { error: 'leader response was not valid JSON' };
  }
}

function shouldRetryLeaderJson(raw: string, error: string): boolean {
  if (raw.length === 0) return false;
  return [
    'leader response was not valid JSON',
    'leader response did not contain JSON',
    'leader response type must be final, plan, or need_user_input',
    'leader JSON must be an object',
  ].includes(error);
}

function repairLooseFinalJson(candidate: string): Record<string, unknown> | undefined {
  if (!/"type"\s*:\s*"final"\s*(?:,|})/m.test(candidate)) return undefined;

  const summary = extractLooseStringField(candidate, 'summary', ['result']);
  const result = extractLooseStringField(candidate, 'result');
  if (summary === undefined || result === undefined || result.trim() === '') return undefined;

  return { type: 'final', summary, result };
}

function extractLooseStringField(candidate: string, field: string, nextFields: string[] = []): string | undefined {
  const key = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`, 'm');
  const match = key.exec(candidate);
  if (!match || match.index === undefined) return undefined;

  const start = match.index + match[0].length;
  let end = -1;
  for (const nextField of nextFields) {
    const next = new RegExp(`"\\s*,\\s*"${escapeRegExp(nextField)}"\\s*:`, 'm').exec(candidate.slice(start));
    if (next && next.index !== undefined) {
      end = start + next.index;
      break;
    }
  }

  if (end === -1) {
    const objectEnd = candidate.lastIndexOf('}');
    if (objectEnd === -1) return undefined;
    end = candidate.lastIndexOf('"', objectEnd);
  }
  if (end < start) return undefined;

  return decodeLooseJsonString(candidate.slice(start, end));
}

function decodeLooseJsonString(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      decoded += char;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }

    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    decoded += escapes[next] ?? next;
    index += 1;
  }
  return decoded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateLeaderPlan(raw: Record<string, unknown>, members: TeamWithMembers['members']): LeaderOutcome {
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return { error: 'leader plan summary is required' };
  if (!Array.isArray(raw.assignments) || raw.assignments.length === 0) {
    return { error: 'leader plan assignments are required' };
  }

  const availableRoles = members.map((member) => member.role);
  const memberByRole = new Map(members.map((member) => [member.role, member]));
  const deliveryIdByAssignmentId = new Map<string, string>();
  const assignments: Array<{
    id: string;
    to: string;
    to_member_id: string;
    task: string;
    context: string;
    depends_on: string[];
    dependency_type: TeamDeliveryDependencyType;
  }> = [];

  for (const item of raw.assignments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'leader plan assignment must be an object' };
    }
    const assignment = item as Record<string, unknown>;
    const id = typeof assignment.id === 'string' ? assignment.id.trim() : '';
    if (!id) return { error: 'leader plan assignment id is required' };
    if (deliveryIdByAssignmentId.has(id)) return { error: `duplicate assignment id: ${id}` };

    const to = typeof assignment.to === 'string' ? assignment.to.trim() : '';
    const member = memberByRole.get(to);
    if (!member) {
      return {
        error: `unknown assignment target role: ${to || '(empty)'}. Available roles: ${availableRoles.join(', ')}`,
      };
    }

    const task = typeof assignment.task === 'string' ? assignment.task.trim() : '';
    if (!task) return { error: `assignment ${id} task is required` };
    const context = typeof assignment.context === 'string' ? assignment.context.trim() : '';
    const rawDependsOn = assignment.depends_on ?? [];
    if (!Array.isArray(rawDependsOn) || rawDependsOn.some((dep) => typeof dep !== 'string' || dep.trim() === '')) {
      return { error: `assignment ${id} depends_on must be an array of assignment ids` };
    }
    const dependency_type = assignment.dependency_type ?? 'success';
    if (dependency_type !== 'success' && dependency_type !== 'finished') {
      return { error: `assignment ${id} dependency_type must be success or finished` };
    }

    const delivery_id = randomUUID();
    deliveryIdByAssignmentId.set(id, delivery_id);
    assignments.push({
      id,
      to,
      to_member_id: member.member_id,
      task,
      context,
      depends_on: rawDependsOn.map((dep) => dep.trim()),
      dependency_type,
    });
  }

  const validated: ValidatedPlanAssignment[] = [];
  for (const assignment of assignments) {
    const dependencies: ValidatedPlanAssignment['dependencies'] = [];
    for (const dep of assignment.depends_on) {
      const depends_on_delivery_id = deliveryIdByAssignmentId.get(dep);
      if (!depends_on_delivery_id) {
        return { error: `assignment ${assignment.id} depends on unknown assignment: ${dep}` };
      }
      dependencies.push({ depends_on_delivery_id, dependency_type: assignment.dependency_type });
    }
    validated.push({
      ...assignment,
      delivery_id: deliveryIdByAssignmentId.get(assignment.id)!,
      dependencies,
    });
  }

  return { type: 'plan', summary, assignments: validated };
}

function assignmentContent(assignment: ValidatedPlanAssignment): string {
  return [
    `Assignment ${assignment.id} -> ${assignment.to}`,
    '',
    `Task: ${assignment.task}`,
    assignment.context ? `Context: ${assignment.context}` : '',
    assignment.depends_on.length > 0 ? `Depends on: ${assignment.depends_on.join(', ')}` : 'Depends on: none',
  ]
    .filter(Boolean)
    .join('\n');
}

function deliveryPrompt({
  delivery,
  message,
  member,
  includeInitialization,
  dependencies,
  runItems,
}: {
  delivery: TeamMessageDeliveryRecord;
  message: TeamMessageRecord;
  member: TeamMemberRecord;
  includeInitialization: boolean;
  dependencies: Array<{ depends_on_delivery_id: string; dependency_type: TeamDeliveryDependencyType }>;
  runItems: TeamRunWithItems | undefined;
}): string {
  const dependencyLines = dependencies.map((dependency) => {
    const upstream = runItems?.deliveries.find((item) => item.delivery_id === dependency.depends_on_delivery_id);
    const upstreamMessage = upstream
      ? runItems?.messages.find((item) => item.message_id === upstream.message_id)
      : undefined;
    return [
      `- ${dependency.depends_on_delivery_id}: requires ${dependency.dependency_type}, status=${upstream?.status ?? 'unknown'}`,
      upstream?.error ? `  Error: ${upstream.error}` : '',
      upstreamMessage ? `  Summary: ${compactForPrompt(upstreamMessage.content)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    includeInitialization ? 'Member initialization (first delivery only):' : '',
    includeInitialization ? memberInitializationPrompt(member) : '',
    includeInitialization ? '' : '',
    `New delivery: ${delivery.delivery_id}`,
    `Run: ${delivery.run_id}`,
    '',
    'Task:',
    message.content,
    '',
    'Dependency summaries:',
    dependencyLines.length > 0 ? dependencyLines.join('\n') : '- none',
    '',
    'Expected output:',
    '- Complete the assigned task in this existing team session.',
    '- Report one concise outbound message for the leader.',
    '- Start with exactly one of: RESULT:, REVIEW:, NEED_INFO:, PROPOSAL:, FAILED:, or MESSAGE_TO role:.',
  ].join('\n');
}

function compactForPrompt(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 240) return normalized;
  return `[orchestrator excerpt shortened for prompt budget; original message may be complete] ${normalized.slice(0, 237)}`;
}
