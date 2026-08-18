import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { BaseAdapter } from './adapters/base';
import { AdapterRegistry } from './adapters/registry';
import { SessionStore } from './db';
import { SseHub } from './sse';
import type { PromptHandlers } from '../shared/adapter';
import type { ServerEvent } from '../shared/events';
import type { SessionRecord, SessionStatus } from '../shared/session';

/** In-process fake adapter that records calls and returns deterministic ids. */
class ScriptedAdapter extends BaseAdapter {
  readonly created: string[] = [];
  promptCalls: Array<{ real_session_id: string; cwd: string; input: string }> = [];
  /** If set, run this script when prompt is called (drives the stream handlers). */
  promptScript?: (handlers: PromptHandlers) => void;
  /** If set, prompt rejects with this message instead of running the script. */
  promptError?: string;

  async createSession(cwd: string): Promise<{ real_session_id: string }> {
    this.created.push(cwd);
    return { real_session_id: `native-${cwd}` };
  }

  async prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    this.promptCalls.push({ real_session_id, cwd, input });
    if (this.promptError) throw new Error(this.promptError);
    if (this.promptScript) this.promptScript(handlers);
  }
}

async function startServer(dbPath?: string) {
  const db = new Database(dbPath ?? ':memory:');
  const store = new SessionStore(db);
  const adapters = new AdapterRegistry();
  const fake = new ScriptedAdapter();
  adapters.register('fake', fake);
  const sse = new SseHub();
  const app = createApp({ store, adapters, sse });

  let server!: ServerType;
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return { db, fake, server, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`read timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Read SSE `data:` lines until one of the given type arrives. */
async function waitForEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  type: string,
  timeoutMs = 5000,
): Promise<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await readWithTimeout(reader.read(), deadline - Date.now());
    if (done) throw new Error('SSE stream ended before the expected event');
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim()) as ServerEvent;
      if (event.type === type) return event;
    }
  }
  throw new Error(`timed out waiting for SSE event '${type}'`);
}

/**
 * Read SSE `data:` lines, collecting events in arrival order until `isDone`
 * returns true for the events seen so far.
 */
async function collectEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  isDone: (events: ServerEvent[]) => boolean,
  timeoutMs = 5000,
): Promise<ServerEvent[]> {
  const events: ServerEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await readWithTimeout(reader.read(), deadline - Date.now());
    if (done) throw new Error('SSE stream ended before the expected events');
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice(5).trim()) as ServerEvent);
      if (isDone(events)) return events;
    }
  }
  throw new Error(`timed out; saw events: ${JSON.stringify(events.map((e) => e.type))}`);
}

describe('walking skeleton', () => {
  it('creates a session and lists it with name, agent, directory, and status', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const res = await post(baseUrl, '/api/sessions', {
        cwd: '/tmp/project',
        agent: 'fake',
        name: 'my session',
      });
      expect(res.status).toBe(201);

      const created = (await res.json()) as SessionRecord;
      expect(created).toMatchObject({
        coding_agent: 'fake',
        name: 'my session',
        cwd: '/tmp/project',
        status: 'completed',
      });
      expect(created.session_id).toBeTruthy();
      expect(created.real_session_id).toBe('native-/tmp/project');

      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ session_id: created.session_id, name: 'my session' });
    } finally {
      server.close();
      db.close();
    }
  });

  it('persists sessions across a restart (SQLite is the source of truth)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-test-'));
    const dbPath = join(dir, 'sessions.db');
    try {
      const first = await startServer(dbPath);
      const created = (await (
        await post(first.baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'persist me' })
      ).json()) as SessionRecord;
      first.server.close();
      first.db.close();

      const second = await startServer(dbPath);
      try {
        const list = (await (await fetch(`${second.baseUrl}/api/sessions`)).json()) as SessionRecord[];
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ session_id: created.session_id, name: 'persist me' });
      } finally {
        second.server.close();
        second.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams a session_created event tagged with session_id over SSE', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      const eventPromise = waitForEvent(reader, 'session_created');

      // Let the SSE subscription register before broadcasting.
      await sleep(30);
      const created = (await (
        await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'sse session' })
      ).json()) as SessionRecord;

      const event = await eventPromise;
      expect(event.type).toBe('session_created');
      expect(event.session_id).toBe(created.session_id);
      expect((event as { session: SessionRecord }).session.name).toBe('sse session');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('rejects a session for an unknown agent', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const res = await post(baseUrl, '/api/sessions', {
        cwd: '/tmp/p',
        agent: 'not-an-agent',
        name: 'nope',
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('streaming conversation (ticket #2)', () => {
  it('streams a reply as text deltas over SSE and moves status running → completed', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers) => {
        handlers.onTextDelta('Hello');
        handlers.onTextDelta(' world');
        handlers.onStatusChange('completed');
      };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      // Let the SSE subscription register before any broadcast.
      await sleep(30);

      const created = (await (
        await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'chat' })
      ).json()) as SessionRecord;

      const res = await post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'hi' });
      expect(res.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((e) => e.type === 'status_change' && e.status === 'completed'),
      );

      // The client sees: created → running → text deltas → completed, all tagged.
      expect(events.map((e) => e.type)).toEqual([
        'session_created',
        'status_change',
        'text_delta',
        'text_delta',
        'status_change',
      ]);
      for (const event of events) expect(event.session_id).toBe(created.session_id);

      const texts = events
        .filter((e): e is { type: 'text_delta'; session_id: string; text: string } => e.type === 'text_delta')
        .map((e) => e.text);
      expect(texts).toEqual(['Hello', ' world']);

      const statuses = events
        .filter(
          (e): e is { type: 'status_change'; session_id: string; status: SessionStatus } =>
            e.type === 'status_change',
        )
        .map((e) => e.status);
      expect(statuses).toEqual(['running', 'completed']);

      // The adapter was driven with the session's real id, cwd and the message text.
      expect(fake.promptCalls).toEqual([
        { real_session_id: 'native-/tmp/p', cwd: '/tmp/p', input: 'hi' },
      ]);

      // The persisted session reflects the final status.
      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(list[0].status).toBe('completed');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('streams thinking and tool call events with their name and arguments', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers) => {
        handlers.onThinkingDelta('Let me check');
        handlers.onToolCallStart('tc-1', 'Bash', { command: 'ls -la' });
        handlers.onToolCallEnd('tc-1');
        handlers.onStatusChange('completed');
      };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const created = (await (
        await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'chat' })
      ).json()) as SessionRecord;
      await post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'go' });

      const events = await collectEvents(
        reader,
        (evs) => evs.some((e) => e.type === 'status_change' && e.status === 'completed'),
      );

      const thinking = events
        .filter((e): e is { type: 'thinking_delta'; session_id: string; text: string } => e.type === 'thinking_delta')
        .map((e) => e.text);
      expect(thinking).toEqual(['Let me check']);

      const starts = events.filter(
        (e): e is { type: 'tool_call_start'; session_id: string; tool_call_id: string; name: string; input: unknown } =>
          e.type === 'tool_call_start',
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        session_id: created.session_id,
        tool_call_id: 'tc-1',
        name: 'Bash',
        input: { command: 'ls -la' },
      });

      const ends = events.filter(
        (e): e is { type: 'tool_call_end'; session_id: string; tool_call_id: string } =>
          e.type === 'tool_call_end',
      );
      expect(ends.map((e) => e.tool_call_id)).toEqual(['tc-1']);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('marks the session error and streams an error event when the turn fails', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptError = 'kaboom';
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const created = (await (
        await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'boom' })
      ).json()) as SessionRecord;
      const res = await post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'go' });
      expect(res.status).toBe(202);

      const events = await collectEvents(reader, (evs) => evs.some((e) => e.type === 'error'));
      const statuses = events
        .filter(
          (e): e is { type: 'status_change'; session_id: string; status: SessionStatus } =>
            e.type === 'status_change',
        )
        .map((e) => e.status);
      expect(statuses).toContain('error');

      const errors = events.filter(
        (e): e is { type: 'error'; session_id: string; message: string } => e.type === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].session_id).toBe(created.session_id);
      expect(errors[0].message).toContain('kaboom');

      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(list[0].status).toBe('error');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('rejects a message for a missing session (404) and for empty text (400)', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const missing = await post(baseUrl, '/api/sessions/does-not-exist/message', { text: 'hi' });
      expect(missing.status).toBe(404);

      const created = (await (
        await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'chat' })
      ).json()) as SessionRecord;

      const emptyText = await post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: '  ' });
      expect(emptyText.status).toBe(400);
      const noText = await post(baseUrl, `/api/sessions/${created.session_id}/message`, {});
      expect(noText.status).toBe(400);
    } finally {
      server.close();
      db.close();
    }
  });
});
