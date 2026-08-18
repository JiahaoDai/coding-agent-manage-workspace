import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AdapterRegistry } from './adapters/registry';
import type { SessionStore } from './db';
import type { SseHub } from './sse';
import type { PromptHandlers } from '../shared/adapter';
import type { SessionRecord } from '../shared/session';

export interface AppDeps {
  store: SessionStore;
  adapters: AdapterRegistry;
  sse: SseHub;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/agents', (c) => c.json(deps.adapters.list()));

  app.get('/api/sessions', (c) => c.json(deps.store.list()));

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
      create_time: now,
      modify_time: now,
    };

    deps.store.insert(session);
    deps.sse.broadcast({ type: 'session_created', session_id: session.session_id, session });

    return c.json(session, 201);
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
      onStatusChange: (status) => {
        // The server sets `running` at turn start, so an adapter reporting the
        // same status again must not double-write or double-broadcast.
        const current = deps.store.get(session_id);
        if (current && current.status === status) return;
        deps.store.updateStatus(session_id, status);
        deps.sse.broadcast({ type: 'status_change', session_id, status });
      },
      // Interactive permission confirmation is ticket #3. Until then, deny by
      // default — never auto-allow a tool. Nothing is broadcast because no
      // client consumes permission requests yet.
      onPermissionRequest: async () => 'deny',
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
      deps.store.updateStatus(session_id, 'error');
      deps.sse.broadcast({ type: 'status_change', session_id, status: 'error' });
      deps.sse.broadcast({
        type: 'error',
        session_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json({ ok: true }, 202);
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
