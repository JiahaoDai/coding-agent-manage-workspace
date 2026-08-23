import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { BaseAdapter } from './adapters/base';
import { AdapterRegistry } from './adapters/registry';
import { SessionStore } from './db';
import { FsTree } from './fs/tree';
import { SseHub } from './sse';
import type { PromptHandlers } from '../shared/adapter';
import type { ServerEvent } from '../shared/events';
import type { Message, SessionRecord, SessionStatus } from '../shared/session';

/** Context a script sees for the prompt it is driving. */
interface PromptContext {
  real_session_id: string;
  cwd: string;
  input: string;
}

/** In-process fake adapter that records calls and returns deterministic ids. */
class ScriptedAdapter extends BaseAdapter {
  readonly created: string[] = [];
  promptCalls: Array<{ real_session_id: string; cwd: string; input: string }> = [];
  /** If set, run this script when prompt is called (drives the stream handlers). */
  promptScript?: (handlers: PromptHandlers, ctx: PromptContext) => void | Promise<void>;
  /** If set, prompt rejects with this message instead of running the script. */
  promptError?: string;
  modelSetCalls: Array<{ real_session_id: string; model_id: string | null }> = [];
  /** Decisions the adapter saw from onPermissionRequest, in call order. */
  permissionDecisions: Array<{
    request_id: string;
    tool_name: string;
    input: unknown;
    decision: 'allow' | 'deny';
  }> = [];

  /** High-water mark of prompts in flight — proves turns overlap. */
  maxConcurrentPrompts = 0;
  private activePrompts = 0;

  /** Simulated native store, separate from the app's SQLite store. Persists
   * across soft deletes so re-import is testable. */
  readonly nativeSessions: Array<{ real_session_id: string; cwd: string; summary: string }> = [];

  /** Native sessions the server asked to open/resume, in call order. */
  readonly openCalls: Array<{ real_session_id: string; cwd: string }> = [];

  /** Messages served for any session — history read at display time. */
  scriptedMessages: Message[] = [];

  async getMessages(_real_session_id: string, _cwd: string): Promise<Message[]> {
    return this.scriptedMessages;
  }

  async createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }> {
    this.created.push(cwd);
    const countForCwd = this.nativeSessions.filter((session) => session.cwd === cwd).length;
    const real_session_id = countForCwd === 0 ? `native-${cwd}` : `native-${cwd}-${countForCwd + 1}`;
    this.nativeSessions.push({ real_session_id, cwd, summary: opts?.name ?? 'native session' });
    return { real_session_id };
  }

  async openSession(real_session_id: string, cwd: string): Promise<{ real_session_id: string }> {
    this.openCalls.push({ real_session_id, cwd });
    return { real_session_id };
  }

  async listSessions(cwd: string): Promise<Array<{ real_session_id: string; cwd: string; summary: string }>> {
    return this.nativeSessions
      .filter((n) => n.cwd === cwd)
      .map(({ real_session_id, cwd: c, summary }) => ({ real_session_id, cwd: c, summary }));
  }

  async prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    this.promptCalls.push({ real_session_id, cwd, input });
    this.activePrompts += 1;
    this.maxConcurrentPrompts = Math.max(this.maxConcurrentPrompts, this.activePrompts);
    try {
      if (this.promptError) throw new Error(this.promptError);
      if (this.promptScript) await this.promptScript(handlers, { real_session_id, cwd, input });
    } finally {
      this.activePrompts -= 1;
    }
  }

  async listModels() {
    return { supported: true as const, value: [{ id: 'fake/fast', label: 'Fake Fast', provider: 'fake' }] };
  }

  async setModel(real_session_id: string, _cwd: string, model_id: string | null) {
    if (model_id !== null && model_id !== 'fake/fast') throw new Error(`Model is not available: ${model_id}`);
    this.modelSetCalls.push({ real_session_id, model_id });
    return { supported: true as const, value: undefined };
  }

}

async function startServer(opts?: { dbPath?: string; fs?: FsTree }) {
  const db = new Database(opts?.dbPath ?? ':memory:');
  const store = new SessionStore(db);
  const adapters = new AdapterRegistry();
  const fake = new ScriptedAdapter();
  adapters.register('fake', fake);
  const sse = new SseHub();
  const app = createApp({ store, adapters, sse, fs: opts?.fs });

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

async function createSession(baseUrl: string, name: string): Promise<SessionRecord> {
  const res = await post(baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name });
  expect(res.status).toBe(201);
  return (await res.json()) as SessionRecord;
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
      const first = await startServer({ dbPath });
      const created = (await (
        await post(first.baseUrl, '/api/sessions', { cwd: '/tmp/p', agent: 'fake', name: 'persist me' })
      ).json()) as SessionRecord;
      first.server.close();
      first.db.close();

      const second = await startServer({ dbPath });
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

describe('agent teams (v3 ticket #1)', () => {
  it('creates a team with fresh member sessions and sends each initialization prompt once', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers) => handlers.onStatusChange('completed');
      const res = await post(baseUrl, '/api/teams', {
        name: 'Product Builder',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Lead the team and produce final answers.',
          },
          {
            role: 'docs-writer',
            agent: 'fake',
            model: 'fake/fast',
            responsibility_prompt: 'Write user-facing docs for completed team work.',
          },
        ],
      });

      expect(res.status).toBe(201);
      const created = await res.json() as {
        team_id: string;
        name: string;
        cwd: string;
        members: Array<{ role: string; session_id: string; coding_agent: string; model: string | null }>;
      };
      expect(created).toMatchObject({ name: 'Product Builder', cwd: '/tmp/team-project' });
      expect(created.members.map((member) => member.role)).toEqual(['leader', 'docs-writer']);
      expect(new Set(created.members.map((member) => member.session_id)).size).toBe(2);

      const sessions = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(sessions.filter((session) => session.cwd === '/tmp/team-project')).toHaveLength(0);
      expect(fake.promptCalls).toHaveLength(2);
      expect(fake.promptCalls[0].input).toContain('You are leader in an agent team.');
      expect(fake.promptCalls[0].input).toContain('Lead the team and produce final answers.');
      expect(fake.promptCalls[1].input).toContain('You are docs-writer in an agent team.');
      expect(fake.promptCalls[1].input).toContain('Write user-facing docs for completed team work.');
      expect(fake.modelSetCalls).toEqual([{ real_session_id: 'native-/tmp/team-project-2', model_id: 'fake/fast' }]);

      const listed = await (await fetch(`${baseUrl}/api/teams`)).json() as Array<{ team_id: string; members: unknown[] }>;
      expect(listed).toHaveLength(1);
      expect(listed[0].team_id).toBe(created.team_id);
      expect(listed[0].members).toHaveLength(2);

      const promptCountAfterList = fake.promptCalls.length;
      await fetch(`${baseUrl}/api/teams`);
      expect(fake.promptCalls).toHaveLength(promptCountAfterList);
    } finally {
      server.close();
      db.close();
    }
  });

  it('fails team creation when initialization asks for tool permission', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = async (handlers) => {
        await handlers.onPermissionRequest('init-perm', 'Bash', { command: 'echo no' });
      };

      const res = await post(baseUrl, '/api/teams', {
        name: 'Unsafe Init',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Lead the team.',
          },
        ],
      });

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'team member initialization requested permission for Bash',
      });
      expect(await (await fetch(`${baseUrl}/api/teams`)).json()).toEqual([]);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('streaming conversation (ticket #2)', () => {
  it('lists available models and persists a selection only after the adapter accepts it', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const created = await createSession(baseUrl, 'models');
      const available = await fetch(`${baseUrl}/api/sessions/${created.session_id}/models`);
      expect(await available.json()).toEqual({ supported: true, value: [{ id: 'fake/fast', label: 'Fake Fast', provider: 'fake' }] });

      const selected = await post(baseUrl, `/api/sessions/${created.session_id}/model`, { model_id: 'fake/fast' });
      expect(selected.status).toBe(200);
      expect((await selected.json()) as SessionRecord).toMatchObject({ model: 'fake/fast' });

      const rejected = await post(baseUrl, `/api/sessions/${created.session_id}/model`, { model_id: 'missing/model' });
      expect(rejected.status).toBe(422);
      const stored = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(stored[0].model).toBe('fake/fast');
      expect(fake.modelSetCalls).toEqual([{ real_session_id: created.real_session_id, model_id: 'fake/fast' }]);
    } finally { server.close(); db.close(); }
  });
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
      expect(list[0].last_error).toContain('kaboom');

      fake.promptError = undefined;
      const retry = await post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'try again' });
      expect(retry.status).toBe(202);
      const recovered = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(recovered[0]).toMatchObject({ status: 'completed', last_error: null });

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

describe('interactive permission confirmation (ticket #3)', () => {
  /** Script that asks one permission request and records the decision it saw. */
  function permissionScript(fake: ScriptedAdapter, request_id: string) {
    return async (handlers: PromptHandlers): Promise<void> => {
      const decision = await handlers.onPermissionRequest(request_id, 'Bash', { command: 'ls' });
      fake.permissionDecisions.push({ request_id, tool_name: 'Bash', input: { command: 'ls' }, decision });
      handlers.onStatusChange('completed');
    };
  }

  it('broadcasts the request (tool name + args) and allow lets the agent proceed', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = permissionScript(fake, 'p-1');

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const created = await createSession(baseUrl, 'perm allow');

      // Fire the message without awaiting: the turn pauses on the permission
      // request and only finishes after we answer it.
      const sendPromise = post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'go' });

      const request = await waitForEvent(reader, 'permission_request');
      expect(request).toMatchObject({
        type: 'permission_request',
        session_id: created.session_id,
        request_id: 'p-1',
        tool_name: 'Bash',
        input: { command: 'ls' },
      });

      const res = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, {
        request_id: 'p-1',
        decision: 'allow',
      });
      expect(res.status).toBe(200);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((e) => e.type === 'status_change' && e.status === 'completed'),
      );

      // The adapter saw the allow and the turn completed.
      expect(fake.permissionDecisions).toEqual([
        { request_id: 'p-1', tool_name: 'Bash', input: { command: 'ls' }, decision: 'allow' },
      ]);
      expect(events.some((e) => e.type === 'permission_response' && e.decision === 'allow')).toBe(true);

      await sendPromise;
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('deny is reported back to the agent, which completes adjusted', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = permissionScript(fake, 'p-2');

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const created = await createSession(baseUrl, 'perm deny');
      const sendPromise = post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'go' });

      await waitForEvent(reader, 'permission_request');
      const res = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, {
        request_id: 'p-2',
        decision: 'deny',
      });
      expect(res.status).toBe(200);

      await collectEvents(
        reader,
        (evs) => evs.some((e) => e.type === 'status_change' && e.status === 'completed'),
      );

      expect(fake.permissionDecisions[0].decision).toBe('deny');

      await sendPromise;
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('rejects a permission response aimed at a different session', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = permissionScript(fake, 'p-3');

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const owner = await createSession(baseUrl, 'owner');
      const other = await createSession(baseUrl, 'other');
      const sendPromise = post(baseUrl, `/api/sessions/${owner.session_id}/message`, { text: 'go' });

      const event = await waitForEvent(reader, 'permission_request');
      const request = event as Extract<ServerEvent, { type: 'permission_request' }>;

      // Answering the owner's request through the *other* session's endpoint
      // must not resolve it.
      const wrong = await post(baseUrl, `/api/sessions/${other.session_id}/permission`, {
        request_id: request.request_id,
        decision: 'allow',
      });
      expect(wrong.status).toBe(404);

      const right = await post(baseUrl, `/api/sessions/${owner.session_id}/permission`, {
        request_id: request.request_id,
        decision: 'allow',
      });
      expect(right.status).toBe(200);

      await sendPromise;
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('rejects malformed permission responses and unknown requests', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = permissionScript(fake, 'p-4');

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const created = await createSession(baseUrl, 'perm validation');
      const sendPromise = post(baseUrl, `/api/sessions/${created.session_id}/message`, { text: 'go' });

      await waitForEvent(reader, 'permission_request');

      // Missing session.
      const missing = await post(baseUrl, `/api/sessions/does-not-exist/permission`, {
        request_id: 'p-4',
        decision: 'allow',
      });
      expect(missing.status).toBe(404);

      // Missing / bad request id and bad decision.
      const noId = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, { decision: 'allow' });
      expect(noId.status).toBe(400);
      const badDecision = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, {
        request_id: 'p-4',
        decision: 'maybe',
      });
      expect(badDecision.status).toBe(400);

      // Unknown request id (never asked) → not resolved.
      const unknown = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, {
        request_id: 'never-asked',
        decision: 'allow',
      });
      expect(unknown.status).toBe(404);

      // The real request is still pending and answerable afterwards.
      const ok = await post(baseUrl, `/api/sessions/${created.session_id}/permission`, {
        request_id: 'p-4',
        decision: 'allow',
      });
      expect(ok.status).toBe(200);

      await sendPromise;
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('concurrent sessions (ticket #4)', () => {
  it('runs two sessions concurrently with independent streams and statuses', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      // Stream with pauses so a second prompt starts before the first finishes.
      fake.promptScript = async (handlers) => {
        handlers.onTextDelta('delta');
        await sleep(150);
        handlers.onTextDelta(' delta2');
        await sleep(150);
        handlers.onStatusChange('completed');
      };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const a = await createSession(baseUrl, 'A');
      const b = await createSession(baseUrl, 'B');

      // Fire both turns without awaiting — the route resolves only when the
      // turn finishes, so awaiting here would serialize them.
      const pA = post(baseUrl, `/api/sessions/${a.session_id}/message`, { text: 'to A' });
      const pB = post(baseUrl, `/api/sessions/${b.session_id}/message`, { text: 'to B' });

      const events = await collectEvents(reader, (evs) => {
        const done = (sid: string) =>
          evs.some(
            (e) =>
              e.type === 'status_change' && e.session_id === sid && e.status === 'completed',
          );
        return done(a.session_id) && done(b.session_id);
      });

      // Both turns overlapped in flight, not serialized.
      expect(fake.maxConcurrentPrompts).toBeGreaterThanOrEqual(2);

      // Every event is tagged with one of the two sessions — nothing cross-wired.
      const ids = new Set(events.map((e) => e.session_id));
      expect([...ids].sort()).toEqual([a.session_id, b.session_id].sort());

      // Each session sees only its own running → completed sequence and text.
      for (const sid of [a.session_id, b.session_id]) {
        const own = events.filter((e) => e.session_id === sid);
        const statuses = own
          .filter((e): e is Extract<ServerEvent, { type: 'status_change' }> => e.type === 'status_change')
          .map((e) => e.status);
        expect(statuses).toEqual(['running', 'completed']);
        const text = own
          .filter((e): e is Extract<ServerEvent, { type: 'text_delta' }> => e.type === 'text_delta')
          .map((e) => e.text)
          .join('');
        expect(text).toBe('delta delta2');
      }

      await Promise.all([pA, pB]);
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('routes permission requests with the same id from two sessions only to their own session', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      // Both sessions ask for the SAME request id — only the session id
      // distinguishes them, which is exactly the cross-talk the broker must resist.
      fake.promptScript = async (handlers) => {
        const decision = await handlers.onPermissionRequest('p-1', 'Bash', { command: 'ls' });
        fake.permissionDecisions.push({
          request_id: 'p-1',
          tool_name: 'Bash',
          input: { command: 'ls' },
          decision,
        });
        handlers.onStatusChange('completed');
      };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const a = await createSession(baseUrl, 'A');
      const b = await createSession(baseUrl, 'B');

      const pA = post(baseUrl, `/api/sessions/${a.session_id}/message`, { text: 'to A' });
      const pB = post(baseUrl, `/api/sessions/${b.session_id}/message`, { text: 'to B' });

      // Wait until a permission_request has surfaced for BOTH sessions.
      const seen = await collectEvents(reader, (evs) => {
        const prs = evs.filter(
          (e): e is Extract<ServerEvent, { type: 'permission_request' }> => e.type === 'permission_request',
        );
        const ids = new Set(prs.map((p) => p.session_id));
        return ids.has(a.session_id) && ids.has(b.session_id);
      });
      const requests = seen.filter(
        (e): e is Extract<ServerEvent, { type: 'permission_request' }> => e.type === 'permission_request',
      );
      expect(requests).toHaveLength(2);
      for (const r of requests) {
        expect(r.request_id).toBe('p-1');
        expect([a.session_id, b.session_id]).toContain(r.session_id);
      }

      // Answer A's request through A's endpoint — B must stay untouched.
      const resA = await post(baseUrl, `/api/sessions/${a.session_id}/permission`, {
        request_id: 'p-1',
        decision: 'allow',
      });
      expect(resA.status).toBe(200);

      await collectEvents(
        reader,
        (evs) =>
          evs.some(
            (e) =>
              e.type === 'status_change' &&
              e.session_id === a.session_id &&
              e.status === 'completed',
          ),
      );

      // A completed; B is still waiting on its own request.
      const sessions = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(sessions.find((s) => s.session_id === a.session_id)?.status).toBe('completed');
      expect(sessions.find((s) => s.session_id === b.session_id)?.status).toBe('running');

      // B's request is still answerable via B's endpoint.
      const resB = await post(baseUrl, `/api/sessions/${b.session_id}/permission`, {
        request_id: 'p-1',
        decision: 'deny',
      });
      expect(resB.status).toBe(200);

      await collectEvents(
        reader,
        (evs) =>
          evs.some(
            (e) =>
              e.type === 'status_change' &&
              e.session_id === b.session_id &&
              e.status === 'completed',
          ),
      );

      // Each turn saw its own decision, in answer order.
      expect(fake.permissionDecisions).toEqual([
        { request_id: 'p-1', tool_name: 'Bash', input: { command: 'ls' }, decision: 'allow' },
        { request_id: 'p-1', tool_name: 'Bash', input: { command: 'ls' }, decision: 'deny' },
      ]);

      await Promise.all([pA, pB]);
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('keeps a failing session independent from a concurrent healthy session', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = async (handlers, ctx) => {
        if (ctx.input === 'boom') throw new Error('A blew up');
        handlers.onTextDelta('B is fine');
        handlers.onStatusChange('completed');
      };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const a = await createSession(baseUrl, 'A');
      const b = await createSession(baseUrl, 'B');

      const pA = post(baseUrl, `/api/sessions/${a.session_id}/message`, { text: 'boom' });
      const pB = post(baseUrl, `/api/sessions/${b.session_id}/message`, { text: 'ok' });

      const events = await collectEvents(reader, (evs) => {
        // Wait for A's error message too — declaring done on the status_change
        // alone can return before the trailing `error` event lands in the
        // stream, making the assertions below race with the SSE reader.
        const aErrored = evs.some(
          (e) => e.type === 'error' && e.session_id === a.session_id,
        );
        const bDone = evs.some(
          (e) =>
            e.type === 'status_change' &&
            e.session_id === b.session_id &&
            e.status === 'completed',
        );
        return aErrored && bDone;
      });

      // A's failure is tagged to A only.
      const errors = events.filter(
        (e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].session_id).toBe(a.session_id);
      expect(errors[0].message).toContain('A blew up');

      // B's stream and status are untouched by A's failure.
      const bStatuses = events
        .filter((e) => e.session_id === b.session_id)
        .filter((e): e is Extract<ServerEvent, { type: 'status_change' }> => e.type === 'status_change')
        .map((e) => e.status);
      expect(bStatuses).toEqual(['running', 'completed']);
      const bText = events
        .filter((e) => e.session_id === b.session_id)
        .filter((e): e is Extract<ServerEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.text);
      expect(bText).toEqual(['B is fine']);

      await Promise.all([pA, pB]);
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('soft delete + re-import (ticket #6)', () => {
  it('soft delete removes the record, broadcasts session_removed, and keeps the native session', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const created = await createSession(baseUrl, 'Doomed');
      const real = created.real_session_id;

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const res = await fetch(`${baseUrl}/api/sessions/${created.session_id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      // Gone from the app's list.
      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(list.some((s) => s.session_id === created.session_id)).toBe(false);

      // The client is told the session was removed.
      const event = await waitForEvent(reader, 'session_removed');
      expect(event.session_id).toBe(created.session_id);

      // The native session is untouched — it still lists under its folder.
      const native = await fake.listSessions(created.cwd);
      expect(native.some((n) => n.real_session_id === real)).toBe(true);
      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('exposes a soft-deleted session as a re-import candidate', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const created = await createSession(baseUrl, 'Orig');
      // While tracked, the native session is NOT a candidate.
      let native = (await (await fetch(`${baseUrl}/api/sessions/native?cwd=${encodeURIComponent(created.cwd)}&agent=fake`)).json()) as unknown[];
      expect(native).toHaveLength(0);

      await fetch(`${baseUrl}/api/sessions/${created.session_id}`, { method: 'DELETE' });

      // After soft delete it is.
      native = (await (await fetch(`${baseUrl}/api/sessions/native?cwd=${encodeURIComponent(created.cwd)}&agent=fake`)).json()) as Array<{
        real_session_id: string;
        cwd: string;
        summary: string;
        coding_agent: string;
      }>;
      expect(native).toEqual([
        {
          real_session_id: created.real_session_id,
          cwd: created.cwd,
          summary: 'Orig',
          coding_agent: 'fake',
        },
      ]);
    } finally {
      server.close();
      db.close();
    }
  });

  it('resumes a deleted session pointing at the same native session and opens it', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const created = await createSession(baseUrl, 'Orig');
      await fetch(`${baseUrl}/api/sessions/${created.session_id}`, { method: 'DELETE' });

      const res = await post(baseUrl, '/api/sessions/resume', {
        cwd: created.cwd,
        agent: 'fake',
        real_session_id: created.real_session_id,
      });
      expect(res.status).toBe(201);

      const resumed = (await res.json()) as SessionRecord;
      // Same native session, brand-new app record, name prefilled from the summary.
      expect(resumed.real_session_id).toBe(created.real_session_id);
      expect(resumed.session_id).not.toBe(created.session_id);
      expect(resumed.name).toBe('Orig');
      expect(resumed.cwd).toBe(created.cwd);
      expect(resumed.status).toBe('completed');

      // The native session was actually opened so its history continues.
      expect(fake.openCalls).toEqual([
        { real_session_id: created.real_session_id, cwd: created.cwd },
      ]);

      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as SessionRecord[];
      expect(list.map((s) => s.session_id)).toEqual([resumed.session_id]);
    } finally {
      server.close();
      db.close();
    }
  });

  it('refuses to import a session the app already tracks, or a missing native session', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const created = await createSession(baseUrl, 'Already here');

      // Already tracked → conflict.
      const dup = await post(baseUrl, '/api/sessions/resume', {
        cwd: created.cwd,
        agent: 'fake',
        real_session_id: created.real_session_id,
      });
      expect(dup.status).toBe(409);

      // Native session does not exist → not found.
      const missing = await post(baseUrl, '/api/sessions/resume', {
        cwd: created.cwd,
        agent: 'fake',
        real_session_id: 'native-does-not-exist',
      });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
      db.close();
    }
  });

  it('validates delete and import inputs', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const del = await fetch(`${baseUrl}/api/sessions/nope`, { method: 'DELETE' });
      expect(del.status).toBe(404);

      const emptyImport = await post(baseUrl, '/api/sessions/resume', {});
      expect(emptyImport.status).toBe(400);

      const nativeNoCwd = await fetch(`${baseUrl}/api/sessions/native?agent=fake`);
      expect(nativeNoCwd.status).toBe(400);

      const nativeBadAgent = await fetch(
        `${baseUrl}/api/sessions/native?cwd=/tmp/x&agent=unknown`,
      );
      expect(nativeBadAgent.status).toBe(400);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('session history (ticket #13)', () => {
  it('serves a session\'s messages read from the native store at display time', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.scriptedMessages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ];
      const created = await createSession(baseUrl, 'history');

      const res = await fetch(`${baseUrl}/api/sessions/${created.session_id}/messages`);
      expect(res.status).toBe(200);
      const messages = (await res.json()) as Message[];
      expect(messages).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
    } finally {
      server.close();
      db.close();
    }
  });

  it('404s for a missing session', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/sessions/does-not-exist/messages`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('file tree (ticket #8)', () => {
  /** Create a temp root: two dirs, one hidden dir, one file, and a nested dir. */
  function buildTree(): { root: FsTree; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dash-fs-'));
    mkdirSync(join(dir, 'zzz'));
    mkdirSync(join(dir, 'aaa'));
    mkdirSync(join(dir, '.hidden'));
    mkdirSync(join(dir, 'aaa', 'inner'));
    writeFileSync(join(dir, 'bbb.txt'), 'x');
    return { root: new FsTree(dir), dir };
  }

  it('serves the root and lists one level, dirs first, hidden skipped', async () => {
    const { root, dir } = buildTree();
    const { db, server, baseUrl } = await startServer({ fs: root });
    try {
      const rootRes = (await (await fetch(`${baseUrl}/api/fs/root`)).json()) as {
        root: string;
        name: string;
      };
      expect(rootRes).toEqual({ root: dir, name: basename(dir) });

      const level = (await (
        await fetch(`${baseUrl}/api/fs/children?path=`)
      ).json()) as {
        path: string;
        entries: Array<{ name: string; path: string; absolute: string; is_dir: boolean }>;
      };
      expect(level.entries).toEqual([
        { name: 'aaa', path: 'aaa', absolute: join(dir, 'aaa'), is_dir: true },
        { name: 'zzz', path: 'zzz', absolute: join(dir, 'zzz'), is_dir: true },
        { name: 'bbb.txt', path: 'bbb.txt', absolute: join(dir, 'bbb.txt'), is_dir: false },
      ]);

      const sub = (await (
        await fetch(`${baseUrl}/api/fs/children?path=${encodeURIComponent('aaa')}`)
      ).json()) as { entries: Array<{ name: string; path: string; absolute: string; is_dir: boolean }> };
      expect(sub.entries).toEqual([
        { name: 'inner', path: 'aaa/inner', absolute: join(dir, 'aaa', 'inner'), is_dir: true },
      ]);
    } finally {
      server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths that escape the root', async () => {
    const { root, dir } = buildTree();
    const { db, server, baseUrl } = await startServer({ fs: root });
    try {
      const res = await fetch(`${baseUrl}/api/fs/children?path=${encodeURIComponent('../..')}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('escapes');
    } finally {
      server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
