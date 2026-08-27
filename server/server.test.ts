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

async function startServer(opts?: { dbPath?: string; fs?: FsTree; deliveryRetryBackoffMs?: number[] }) {
  const db = new Database(opts?.dbPath ?? ':memory:');
  const store = new SessionStore(db);
  const adapters = new AdapterRegistry();
  const fake = new ScriptedAdapter();
  adapters.register('fake', fake);
  const sse = new SseHub();
  const app = createApp({ store, adapters, sse, fs: opts?.fs, deliveryRetryBackoffMs: opts?.deliveryRetryBackoffMs });

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
  it('lists models for an agent before a session exists', async () => {
    const { db, server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/agents/fake/models?cwd=${encodeURIComponent('/tmp/project')}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        supported: true,
        value: [{ id: 'fake/fast', label: 'Fake Fast', provider: 'fake' }],
      });
    } finally {
      server.close();
      db.close();
    }
  });

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

  it('persists team runs across a restart as collaboration metadata without native transcript bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-team-history-'));
    const dbPath = join(dir, 'sessions.db');
    try {
      const first = await startServer({ dbPath });
      try {
        first.fake.promptScript = (handlers, ctx) => {
          if (ctx.input.includes('User request:')) {
            handlers.onTextDelta(JSON.stringify({
              type: 'plan',
              summary: 'Implement and summarize the metadata-only history.',
              assignments: [
                {
                  id: 'metadata',
                  to: 'backend-coder',
                  task: 'Write the persisted collaboration metadata summary.',
                  context: 'Do not store full native transcript details.',
                  depends_on: [],
                },
              ],
            }));
            handlers.onStatusChange('completed');
            return;
          }
          if (ctx.input.includes('New delivery:')) {
            handlers.onThinkingDelta('PRIVATE_NATIVE_THINKING_TRACE');
            handlers.onToolCallStart('tool-private', 'Bash', { command: 'cat native.log' });
            handlers.onToolCallEnd('tool-private');
            handlers.onTextDelta('RESULT: Stored run metadata and delivery summaries.');
            handlers.onStatusChange('completed');
            return;
          }
          if (ctx.input.includes('New inbound team message:')) {
            handlers.onTextDelta(JSON.stringify({
              type: 'final',
              summary: 'History persisted.',
              result: 'Team history now reloads from collaboration metadata.',
            }));
            handlers.onStatusChange('completed');
          }
        };

        const createdTeam = await post(first.baseUrl, '/api/teams', {
          name: 'History Team',
          cwd: '/tmp/team-history',
          members: [
            {
              role: 'leader',
              agent: 'fake',
              model: null,
              responsibility_prompt: 'Lead history work.',
            },
            {
              role: 'backend-coder',
              agent: 'fake',
              model: null,
              responsibility_prompt: 'Implement history work.',
            },
          ],
        });
        expect(createdTeam.status).toBe(201);
        const team = await createdTeam.json() as { team_id: string };

        const sseRes = await fetch(`${first.baseUrl}/api/events`);
        const reader = sseRes.body!.getReader();
        await sleep(30);

        const runResponse = await post(first.baseUrl, `/api/teams/${team.team_id}/runs`, {
          text: 'Persist this team run.',
        });
        expect(runResponse.status).toBe(202);
        await collectEvents(reader, (events) => events.some((event) => event.type === 'team_run_completed'));
        await reader.cancel();
      } finally {
        first.server.close();
        first.db.close();
      }

      const second = await startServer({ dbPath });
      try {
        const teams = await (await fetch(`${second.baseUrl}/api/teams`)).json() as Array<{
          team_id: string;
          name: string;
          status: string;
          members: Array<{ role: string; session_id: string; session_missing?: boolean }>;
        }>;
        expect(teams).toHaveLength(1);
        expect(teams[0]).toMatchObject({ name: 'History Team', status: 'idle' });
        expect(teams[0].members.map((member) => member.role)).toEqual(['leader', 'backend-coder']);
        expect(teams[0].members.some((member) => member.session_missing)).toBe(false);

        const runs = await (await fetch(`${second.baseUrl}/api/teams/${teams[0].team_id}/runs`)).json() as Array<{
          run: { status: string };
          messages: Array<{ kind: string; content: string }>;
          deliveries: Array<{ status: string; to_member_id: string }>;
          attempts: Array<{ attempt_id: string; delivery_id: string; status: string; output: string | null }>;
          dependencies: unknown[];
        }>;
        expect(runs).toHaveLength(1);
        expect(runs[0].run.status).toBe('completed');
        expect(runs[0].messages.map((message) => message.kind)).toEqual([
          'user_request',
          'status',
          'assignment',
          'result',
          'final',
        ]);
        expect(runs[0].messages.at(-1)?.content).toBe('Team history now reloads from collaboration metadata.');
        expect(runs[0].deliveries.map((delivery) => delivery.status)).toEqual(['done', 'done', 'done']);
        expect(runs[0].attempts).toHaveLength(3);
        expect(JSON.stringify(runs[0])).not.toContain('PRIVATE_NATIVE_THINKING_TRACE');
        expect(JSON.stringify(runs[0])).not.toContain('tool-private');
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
  it('creates a team with fresh member sessions without prompting agents during creation', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
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
      expect(fake.promptCalls).toHaveLength(0);
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

  it('defers initialization prompts until the member receives a delivery', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = async (handlers) => {
        await handlers.onPermissionRequest('init-perm', 'Bash', { command: 'echo no' });
      };

      const res = await post(baseUrl, '/api/teams', {
        name: 'Deferred Init',
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

      expect(res.status).toBe(201);
      expect(fake.promptCalls).toHaveLength(0);
      expect(await (await fetch(`${baseUrl}/api/teams`)).json()).toHaveLength(1);
    } finally {
      server.close();
      db.close();
    }
  });

  it('rejects an unavailable member model before creating native sessions', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const res = await post(baseUrl, '/api/teams', {
        name: 'Bad Model',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: 'deepseek-v4-flash',
            responsibility_prompt: 'Lead the team.',
          },
        ],
      });

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'model is not available for member leader (fake): deepseek-v4-flash',
        available_models: [{ id: 'fake/fast', label: 'Fake Fast', provider: 'fake' }],
      });
      expect(fake.created).toEqual([]);
      expect(fake.promptCalls).toEqual([]);
    } finally {
      server.close();
      db.close();
    }
  });

  it('deletes a team and its member session records from the dashboard database', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers) => handlers.onStatusChange('completed');
      const created = await post(baseUrl, '/api/teams', {
        name: 'Delete Me',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Lead the team.',
          },
          {
            role: 'tester',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Test the work.',
          },
        ],
      });
      expect(created.status).toBe(201);
      const team = await created.json() as { team_id: string };

      const deleted = await fetch(`${baseUrl}/api/teams/${team.team_id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });

      expect(await (await fetch(`${baseUrl}/api/teams`)).json()).toEqual([]);
      expect(await (await fetch(`${baseUrl}/api/sessions`)).json()).toEqual([]);
      const missing = await fetch(`${baseUrl}/api/teams/${team.team_id}`, { method: 'DELETE' });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('agent team leader-only run (v3 ticket #3)', () => {
  it('creates a run, delivers the request to leader, streams output, and completes with final', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta('{"type":"final","summary":"done",');
          handlers.onTextDelta('"result":"Leader handled the request."}');
        }
        if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'All planned work is done.',
            result: 'Leader reviewed member results and finished.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const createdTeam = await post(baseUrl, '/api/teams', {
        name: 'Product Builder',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Lead the team and produce final answers.',
          },
        ],
      });
      expect(createdTeam.status).toBe(201);
      const team = await createdTeam.json() as {
        team_id: string;
        members: Array<{ member_id: string; session_id: string }>;
      };
      expect(fake.promptCalls).toHaveLength(0);

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Build the settings page.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((e) => e.type === 'team_run_completed'),
      );

      expect(events.map((event) => event.type)).toContain('team_run_created');
      expect(events.map((event) => event.type)).toContain('team_delivery_status_change');
      expect(events.map((event) => event.type)).toContain('team_text_delta');
      expect(events.map((event) => event.type)).toContain('team_run_completed');

      const created = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_created' }> =>
          event.type === 'team_run_created',
      );
      expect(created).toBeTruthy();
      expect(created!.user_message.content).toBe('Build the settings page.');
      expect(created!.delivery.to_member_id).toBe(team.members[0].member_id);

      const streamedEvents = events.filter(
        (event): event is Extract<ServerEvent, { type: 'team_text_delta' }> => event.type === 'team_text_delta',
      );
      expect(streamedEvents.every((event) => event.stream_kind === 'text')).toBe(true);
      const streamed = streamedEvents.map((event) => event.text).join('');
      expect(streamed).toBe('{"type":"final","summary":"done","result":"Leader handled the request."}');

      const completed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_completed' }> =>
          event.type === 'team_run_completed',
      );
      expect(completed!.final_message.content).toBe('Leader handled the request.');
      expect(completed!.run.status).toBe('completed');

      expect(fake.promptCalls).toHaveLength(1);
      expect(fake.promptCalls[0]).toMatchObject({
        real_session_id: 'native-/tmp/team-project',
        cwd: '/tmp/team-project',
      });
      expect(fake.promptCalls[0].input).toContain('User request:');
      expect(fake.promptCalls[0].input).toContain('Build the settings page.');
      expect(fake.promptCalls[0].input).toContain('Member initialization (first delivery only):');
      expect(fake.promptCalls[0].input).toContain('You are leader in an agent team.');
      expect(fake.promptCalls[0].input).toContain('Lead the team and produce final answers.');

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ status: string; to_member_id: string }>;
      }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].run.status).toBe('completed');
      expect(runs[0].messages.map((message) => message.kind)).toEqual(['user_request', 'final']);
      expect(runs[0].messages[1].content).toBe('Leader handled the request.');
      expect(runs[0].deliveries).toEqual([
        expect.objectContaining({ status: 'done', to_member_id: team.members[0].member_id }),
      ]);

      const teams = await (await fetch(`${baseUrl}/api/teams`)).json() as Array<{
        team_id: string;
        status: string;
        members: Array<{ status: string; current_delivery_id: string | null }>;
      }>;
      expect(teams[0]).toMatchObject({ team_id: team.team_id, status: 'idle' });
      expect(teams[0].members[0]).toMatchObject({ status: 'idle', current_delivery_id: null });

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('scopes permission requests to the owning team delivery and resumes it after a response', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = async (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Run backend permission check.',
            assignments: [
              {
                id: 'backend-check',
                to: 'backend-coder',
                task: 'Run the permission-gated check.',
                context: 'Use the existing permission flow.',
                depends_on: [],
              },
            ],
          }));
          handlers.onStatusChange('completed');
          return;
        }
        if (ctx.input.includes('New delivery:')) {
          const decision = await handlers.onPermissionRequest('team-perm-1', 'Bash', { command: 'ls' });
          fake.permissionDecisions.push({
            request_id: 'team-perm-1',
            tool_name: 'Bash',
            input: { command: 'ls' },
            decision,
          });
          handlers.onTextDelta(`RESULT: permission was ${decision}`);
          handlers.onStatusChange('completed');
          return;
        }
        if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Permission flow completed.',
            result: 'Backend permission check completed.',
          }));
          handlers.onStatusChange('completed');
        }
      };

      const createdTeam = await post(baseUrl, '/api/teams', {
        name: 'Permission Team',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Plan permission work.',
          },
          {
            role: 'backend-coder',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Run backend checks.',
          },
        ],
      });
      expect(createdTeam.status).toBe(201);
      const team = await createdTeam.json() as {
        team_id: string;
        members: Array<{ member_id: string; role: string; session_id: string; coding_agent: string }>;
      };
      const backend = team.members.find((member) => member.role === 'backend-coder')!;

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Check backend permissions.',
      });
      expect(runResponse.status).toBe(202);

      const beforePermissionResponse = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'permission_request'),
      );
      const request = beforePermissionResponse.find(
        (event): event is Extract<ServerEvent, { type: 'permission_request' }> => event.type === 'permission_request',
      )!;
      expect(request).toMatchObject({
        type: 'permission_request',
        session_id: backend.session_id,
        request_id: 'team-perm-1',
        tool_name: 'Bash',
        input: { command: 'ls' },
        team_context: {
          team_id: team.team_id,
          team_name: 'Permission Team',
          member_id: backend.member_id,
          member_role: 'backend-coder',
          member_agent: 'fake',
          session_id: backend.session_id,
          cwd: '/tmp/team-project',
        },
      });
      expect(request.team_context!.run_id).toMatch(/[0-9a-f-]{36}/);
      expect(request.team_context!.delivery_id).toMatch(/[0-9a-f-]{36}/);

      const pendingTeams = await (await fetch(`${baseUrl}/api/teams`)).json() as Array<{
        team_id: string;
        members: Array<{ member_id: string; status: string; current_delivery_id: string | null }>;
      }>;
      const pendingBackend = pendingTeams
        .find((item) => item.team_id === team.team_id)!
        .members.find((member) => member.member_id === backend.member_id)!;
      expect(pendingBackend).toMatchObject({
        status: 'waiting_permission',
        current_delivery_id: request.team_context!.delivery_id,
      });

      const response = await post(baseUrl, `/api/sessions/${backend.session_id}/permission`, {
        request_id: 'team-perm-1',
        decision: 'allow',
      });
      expect(response.status).toBe(200);

      const afterPermissionResponse = await collectEvents(
        reader,
        (evs) =>
          evs.some((event) => event.type === 'permission_response') &&
          evs.some((event) => event.type === 'team_run_completed'),
      );
      const responseEvent = afterPermissionResponse.find(
        (event): event is Extract<ServerEvent, { type: 'permission_response' }> => event.type === 'permission_response',
      )!;
      expect(responseEvent).toMatchObject({
        session_id: backend.session_id,
        request_id: 'team-perm-1',
        decision: 'allow',
        team_context: request.team_context,
      });

      expect(fake.permissionDecisions).toEqual([
        { request_id: 'team-perm-1', tool_name: 'Bash', input: { command: 'ls' }, decision: 'allow' },
      ]);

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        deliveries: Array<{ delivery_id: string; status: string }>;
      }>;
      expect(runs[0].run.status).toBe('completed');
      expect(runs[0].deliveries.find((delivery) => delivery.delivery_id === request.team_context!.delivery_id)?.status).toBe('done');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('moves a leader need_user_input outcome into waiting_user and resumes the same run from the user answer', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'need_user_input',
            question: 'Which storage should the team use?',
          }));
          handlers.onStatusChange('completed');
          return;
        }
        if (ctx.input.includes('New inbound team message:')) {
          expect(ctx.input).toContain('Use the existing SQLite database.');
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Storage clarified.',
            result: 'The team will use the existing SQLite database.',
          }));
          handlers.onStatusChange('completed');
        }
      };

      const createdTeam = await post(baseUrl, '/api/teams', {
        name: 'Clarifying Team',
        cwd: '/tmp/team-project',
        members: [
          {
            role: 'leader',
            agent: 'fake',
            model: null,
            responsibility_prompt: 'Lead the team and ask for clarification when needed.',
          },
        ],
      });
      expect(createdTeam.status).toBe(201);
      const team = await createdTeam.json() as { team_id: string; members: Array<{ member_id: string }> };

      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Plan the storage work.',
      });
      expect(runResponse.status).toBe(202);

      const waitingEvents = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_waiting_user'),
      );
      const waiting = waitingEvents.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_waiting_user' }> =>
          event.type === 'team_run_waiting_user',
      )!;
      expect(waiting.run.status).toBe('waiting_user');
      expect(waiting.question_message).toMatchObject({
        kind: 'need_info',
        content: 'Which storage should the team use?',
        from_member_id: team.members[0].member_id,
      });
      expect(waiting.delivery.status).toBe('done');

      let runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { run_id: string; status: string; finish_time: number | null };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ status: string }>;
      }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].run).toMatchObject({ run_id: waiting.run.run_id, status: 'waiting_user', finish_time: null });
      expect(runs[0].messages.map((message) => message.kind)).toEqual(['user_request', 'need_info']);
      expect(runs[0].deliveries).toHaveLength(1);
      expect(runs[0].deliveries[0].status).toBe('done');

      const listedTeams = await (await fetch(`${baseUrl}/api/teams`)).json() as Array<{ team_id: string; status: string }>;
      expect(listedTeams.find((item) => item.team_id === team.team_id)?.status).toBe('waiting_user');

      const resumeResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Use the existing SQLite database.',
      });
      expect(resumeResponse.status).toBe(202);
      const resumedBody = await resumeResponse.json() as { run: { run_id: string; status: string } };
      expect(resumedBody.run.run_id).toBe(waiting.run.run_id);
      expect(resumedBody.run.status).toBe('running');

      const resumedEvents = await collectEvents(
        reader,
        (evs) =>
          evs.some((event) => event.type === 'team_run_resumed') &&
          evs.some((event) => event.type === 'team_run_completed'),
      );
      const resumed = resumedEvents.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_resumed' }> =>
          event.type === 'team_run_resumed',
      )!;
      const completed = resumedEvents.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_completed' }> =>
          event.type === 'team_run_completed',
      )!;
      expect(resumed.run.run_id).toBe(waiting.run.run_id);
      expect(resumed.user_message).toMatchObject({
        kind: 'user_request',
        content: 'Use the existing SQLite database.',
      });
      expect(completed.run.status).toBe('completed');
      expect(completed.final_message.content).toBe('The team will use the existing SQLite database.');

      runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as typeof runs;
      expect(runs).toHaveLength(1);
      expect(runs[0].run.status).toBe('completed');
      expect(runs[0].messages.map((message) => message.kind)).toEqual([
        'user_request',
        'need_info',
        'user_request',
        'final',
      ]);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });
});

describe('agent team leader plan parsing (v3 ticket #4)', () => {
  async function createPlanningTeam(baseUrl: string): Promise<{ team_id: string; members: Array<{ member_id: string; role: string }> }> {
    const createdTeam = await post(baseUrl, '/api/teams', {
      name: 'Product Builder',
      cwd: '/tmp/team-project',
      members: [
        {
          role: 'leader',
          agent: 'fake',
          model: null,
          responsibility_prompt: 'Plan work for the team.',
        },
        {
          role: 'backend-coder',
          agent: 'fake',
          model: null,
          responsibility_prompt: 'Implement backend tasks.',
        },
        {
          role: 'reviewer',
          agent: 'fake',
          model: null,
          responsibility_prompt: 'Review completed work.',
        },
      ],
    });
    expect(createdTeam.status).toBe(201);
    return await createdTeam.json() as { team_id: string; members: Array<{ member_id: string; role: string }> };
  }

  it('turns a valid leader plan into assignment messages, queued deliveries, and dependencies', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Implement API work, then review it.',
            assignments: [
              {
                id: 'api',
                to: 'backend-coder',
                task: 'Implement the API endpoint.',
                context: 'Use existing Hono route patterns.',
                depends_on: [],
              },
              {
                id: 'api-tests',
                to: 'backend-coder',
                task: 'Add route tests.',
                context: 'Cover success and validation errors.',
                depends_on: [],
              },
              {
                id: 'review-api',
                to: 'reviewer',
                task: 'Review the API implementation.',
                context: 'Focus on queue ordering and validation.',
                depends_on: ['api'],
                dependency_type: 'success',
              },
            ],
          }));
        } else if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'All planned work is done.',
            result: 'Leader reviewed member results and finished.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Plan the API work.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => {
          const plan = evs.find(
            (event): event is Extract<ServerEvent, { type: 'team_plan_created' }> =>
              event.type === 'team_plan_created',
          );
          if (!plan) return false;
          return evs.filter(
            (event) =>
              event.type === 'team_delivery_status_change' &&
              event.status === 'done' &&
              plan.deliveries.some((delivery) => delivery.delivery_id === event.delivery_id),
          ).length === plan.deliveries.length;
        },
      );
      const leaderPrompt = fake.promptCalls.find((call) => call.input.includes('User request:'))!.input;
      expect(leaderPrompt).toContain('Available member roles for assignments:');
      expect(leaderPrompt).toContain('- leader: agent=fake');
      expect(leaderPrompt).toContain('- backend-coder: agent=fake');
      expect(leaderPrompt).toContain('- reviewer: agent=fake');
      expect(leaderPrompt).toContain('each assignments[].to MUST be exactly one of: leader, backend-coder, reviewer');

      const planEvent = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_plan_created' }> =>
          event.type === 'team_plan_created',
      );
      expect(planEvent).toBeTruthy();
      expect(planEvent!.plan_message.content).toBe('Implement API work, then review it.');
      expect(planEvent!.assignment_messages).toHaveLength(3);
      expect(planEvent!.assignment_messages[0].content).toContain('Assignment api -> backend-coder');
      expect(planEvent!.deliveries.map((delivery) => delivery.status)).toEqual(['pending', 'pending', 'blocked']);
      expect(planEvent!.dependencies).toEqual([
        {
          delivery_id: planEvent!.deliveries[2].delivery_id,
          depends_on_delivery_id: planEvent!.deliveries[0].delivery_id,
          dependency_type: 'success',
        },
      ]);

      const backend = team.members.find((member) => member.role === 'backend-coder')!;
      const reviewer = team.members.find((member) => member.role === 'reviewer')!;
      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ message_id: string; to_member_id: string; status: string; enqueue_seq: number }>;
        dependencies: Array<{ delivery_id: string; depends_on_delivery_id: string; dependency_type: string }>;
      }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].run.status).toBe('completed');
      const messageKinds = runs[0].messages.map((message) => message.kind);
      expect(messageKinds.slice(0, 2)).toEqual(['user_request', 'status']);
      expect(messageKinds.filter((kind) => kind === 'assignment')).toHaveLength(3);
      expect(messageKinds.filter((kind) => kind === 'result')).toHaveLength(3);
      expect(messageKinds.filter((kind) => kind === 'final')).toHaveLength(1);

      const backendDeliveries = runs[0].deliveries.filter((delivery) => delivery.to_member_id === backend.member_id);
      expect(backendDeliveries.map((delivery) => delivery.enqueue_seq)).toEqual([1, 2]);
      expect(backendDeliveries.map((delivery) => delivery.status)).toEqual(['done', 'done']);

      const reviewerDeliveries = runs[0].deliveries.filter((delivery) => delivery.to_member_id === reviewer.member_id);
      expect(reviewerDeliveries).toEqual([
        expect.objectContaining({ enqueue_seq: 1, status: 'done' }),
      ]);
      expect(runs[0].dependencies).toEqual(planEvent!.dependencies);

      const listedTeams = await (await fetch(`${baseUrl}/api/teams`)).json() as Array<{ team_id: string; status: string }>;
      expect(listedTeams[0]).toMatchObject({ team_id: team.team_id, status: 'idle' });

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('executes queued worker deliveries globally sequentially with incremental prompts', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = async (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Implement API work, tests, and review.',
            assignments: [
              {
                id: 'api',
                to: 'backend-coder',
                task: 'Implement the API endpoint.',
                context: 'Use existing Hono route patterns.',
                depends_on: [],
              },
              {
                id: 'api-tests',
                to: 'backend-coder',
                task: 'Add route tests.',
                context: 'Cover success and validation errors.',
                depends_on: [],
              },
              {
                id: 'review-api',
                to: 'reviewer',
                task: 'Review the API implementation.',
                context: 'Focus on queue ordering and validation.',
                depends_on: ['api'],
                dependency_type: 'success',
              },
            ],
          }));
        } else if (ctx.input.includes('New delivery:')) {
          handlers.onTextDelta(`worked:${ctx.input.match(/Task:\n([\s\S]*?)\n\nDependency summaries:/)?.[1] ?? 'unknown'}`);
          await sleep(60);
        } else if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'All worker deliveries are complete.',
            result: 'Leader finished after reading worker outputs.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Build API, tests, and review.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );
      const planEvent = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_plan_created' }> =>
          event.type === 'team_plan_created',
      );
      expect(planEvent).toBeTruthy();
      const workerDeliveryIds = new Set(planEvent!.deliveries.map((delivery) => delivery.delivery_id));

      let activeWorkerDeliveries = 0;
      let maxActiveWorkerDeliveries = 0;
      for (const event of events) {
        if (event.type !== 'team_delivery_status_change' || !workerDeliveryIds.has(event.delivery_id)) continue;
        if (event.status === 'running') {
          activeWorkerDeliveries += 1;
          maxActiveWorkerDeliveries = Math.max(maxActiveWorkerDeliveries, activeWorkerDeliveries);
        }
        if (event.status === 'done' || event.status === 'failed' || event.status === 'cancelled') {
          activeWorkerDeliveries -= 1;
        }
      }
      expect(maxActiveWorkerDeliveries).toBe(1);
      expect(fake.maxConcurrentPrompts).toBe(1);

      const workerPrompts = fake.promptCalls.map((call) => call.input).filter((input) => input.includes('New delivery:'));
      expect(workerPrompts).toHaveLength(3);
      expect(workerPrompts[0]).toContain('Task: Implement the API endpoint.');
      expect(workerPrompts[1]).toContain('Task: Add route tests.');
      expect(workerPrompts[2]).toContain('Task: Review the API implementation.');
      expect(workerPrompts[2]).toContain('Dependency summaries:');
      expect(workerPrompts[2]).toContain('requires success, status=done');
      expect(workerPrompts[0]).toContain('Member initialization (first delivery only):');
      expect(workerPrompts[0]).toContain('You are backend-coder in an agent team.');
      expect(workerPrompts[0]).toContain('Implement backend tasks.');
      expect(workerPrompts[1]).not.toContain('Member initialization (first delivery only):');
      expect(workerPrompts[1]).not.toContain('You are backend-coder in an agent team.');
      expect(workerPrompts[2]).toContain('Member initialization (first delivery only):');
      expect(workerPrompts[2]).toContain('You are reviewer in an agent team.');
      expect(workerPrompts[2]).toContain('Review completed work.');
      for (const prompt of workerPrompts) {
        expect(prompt).not.toContain('Leader responsibility:');
      }

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        deliveries: Array<{ status: string; to_member_id: string; enqueue_seq: number }>;
      }>;
      expect(runs[0].run.status).toBe('completed');
      expect(runs[0].deliveries.map((delivery) => delivery.status)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done',
        'cancelled',
        'cancelled',
      ]);

      const backend = team.members.find((member) => member.role === 'backend-coder')!;
      expect(runs[0].deliveries.filter((delivery) => delivery.to_member_id === backend.member_id).map((delivery) => delivery.enqueue_seq)).toEqual([1, 2]);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('marks long message bus excerpts so leader does not request resend for complete worker output', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const backendResult = `RESULT: Backend result is complete. ${'backend detail '.repeat(80)}BACKEND_COMPLETE_END`;
      const reviewerResult = `RESULT: Reviewer result is complete. ${'reviewer detail '.repeat(80)}REVIEWER_COMPLETE_END`;
      const leaderFollowUpPrompts: string[] = [];

      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Collect two complete worker results.',
            assignments: [
              {
                id: 'backend-result',
                to: 'backend-coder',
                task: 'Produce a long complete backend result.',
                context: 'Return a complete result.',
                depends_on: [],
              },
              {
                id: 'reviewer-result',
                to: 'reviewer',
                task: 'Produce a long complete reviewer result.',
                context: 'Return a complete result.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('New delivery:')) {
          handlers.onTextDelta(ctx.input.includes('backend result') ? backendResult : reviewerResult);
        } else if (ctx.input.includes('New inbound team message:')) {
          leaderFollowUpPrompts.push(ctx.input);
          const guardedExcerpt =
            ctx.input.includes('Run message bus summary (orchestrator-generated excerpts; not full message bodies):') &&
            ctx.input.includes('[orchestrator excerpt shortened for prompt budget; original message may be complete]') &&
            ctx.input.includes('do not treat that marker as evidence that the original worker output was truncated or incomplete');
          if (!guardedExcerpt && ctx.input.includes('...')) {
            handlers.onTextDelta(JSON.stringify({
              type: 'plan',
              summary: 'Request resend because the message bus looked truncated.',
              assignments: [
                {
                  id: 'resend',
                  to: 'reviewer',
                  task: 'Resend your complete output.',
                  context: 'The leader thought the prior message ended mid-stream.',
                  depends_on: [],
                },
              ],
            }));
          } else {
            handlers.onTextDelta(JSON.stringify({
              type: 'final',
              summary: 'Complete worker outputs were not mistaken for truncation.',
              result: 'Leader handled the available complete worker output without requesting a resend.',
            }));
          }
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Collect both worker results.',
      });
      expect(runResponse.status).toBe(202);

      await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );

      expect(leaderFollowUpPrompts).not.toHaveLength(0);
      expect(leaderFollowUpPrompts[0]).toContain('New inbound team message: full content for this delivery');
      expect(leaderFollowUpPrompts[0]).toContain('BACKEND_COMPLETE_END');
      expect(leaderFollowUpPrompts[0]).toContain('[orchestrator excerpt shortened for prompt budget; original message may be complete]');
      expect(leaderFollowUpPrompts[0]).not.toContain('REVIEWER_COMPLETE_END');

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        messages: Array<{ kind: string; content: string }>;
      }>;
      expect(runs[0].messages.some((message) => message.kind === 'assignment' && message.content.includes('Resend your complete output'))).toBe(false);
      expect(runs[0].messages.some((message) => message.kind === 'result' && message.content.includes('REVIEWER_COMPLETE_END'))).toBe(true);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('waits for runnable non-leader deliveries before leader follow-up', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      const leaderFollowUpPrompts: string[] = [];

      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Collect backend and reviewer wave results.',
            assignments: [
              {
                id: 'backend-wave',
                to: 'backend-coder',
                task: 'Produce backend wave result.',
                context: 'Return a concise backend result.',
                depends_on: [],
              },
              {
                id: 'reviewer-wave',
                to: 'reviewer',
                task: 'Produce reviewer wave result.',
                context: 'Return a concise reviewer result.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('New delivery:')) {
          handlers.onTextDelta(
            ctx.input.includes('backend wave result')
              ? 'RESULT: Backend wave complete.'
              : 'RESULT: Reviewer wave complete.',
          );
        } else if (ctx.input.includes('New inbound team message:')) {
          leaderFollowUpPrompts.push(ctx.input);
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Leader saw the completed wave.',
            result: 'Leader followed up after both non-leader deliveries finished.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Collect a two-worker wave.',
      });
      expect(runResponse.status).toBe(202);

      await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );

      const promptKinds = fake.promptCalls.map((call) => {
        if (call.input.includes('User request:')) return 'leader-plan';
        if (call.input.includes('New inbound team message:')) return 'leader-follow-up';
        if (call.input.includes('Produce backend wave result.')) return 'backend-worker';
        if (call.input.includes('Produce reviewer wave result.')) return 'reviewer-worker';
        return 'unknown';
      });
      expect(promptKinds.slice(0, 4)).toEqual(['leader-plan', 'backend-worker', 'reviewer-worker', 'leader-follow-up']);
      expect(leaderFollowUpPrompts).toHaveLength(1);
      expect(leaderFollowUpPrompts[0]).toContain('Backend wave complete.');
      expect(leaderFollowUpPrompts[0]).toContain('Reviewer wave complete.');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('does not deadlock leader follow-up when non-leader work is retry-delayed or dependency-blocked', async () => {
    const { db, fake, server, baseUrl } = await startServer({ deliveryRetryBackoffMs: [30] });
    try {
      let flakyAttempts = 0;
      const leaderFollowUpPrompts: string[] = [];

      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Exercise retry delay and dependency blocking.',
            assignments: [
              {
                id: 'flaky-backend',
                to: 'backend-coder',
                task: 'Run flaky backend wave task.',
                context: 'This may hit a transient network timeout.',
                depends_on: [],
              },
              {
                id: 'blocked-review',
                to: 'reviewer',
                task: 'Review backend only after success.',
                context: 'This should stay blocked while backend is retry-delayed.',
                depends_on: ['flaky-backend'],
                dependency_type: 'success',
              },
              {
                id: 'independent-review',
                to: 'reviewer',
                task: 'Produce independent reviewer wave result.',
                context: 'This can run without the backend result.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('New inbound team message:')) {
          leaderFollowUpPrompts.push(ctx.input);
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Leader handled the completed worker wave.',
            result: 'Leader completed after retry-delayed and dependency-blocked work finished.',
          }));
        } else if (ctx.input.includes('Review backend only after success.')) {
          handlers.onTextDelta('REVIEW: Blocked review ran after backend retry success.');
        } else if (ctx.input.includes('Run flaky backend wave task.')) {
          flakyAttempts += 1;
          if (flakyAttempts === 1) throw new Error('network timeout while running backend worker');
          handlers.onTextDelta('RESULT: Flaky backend succeeded after retry.');
        } else if (ctx.input.includes('Produce independent reviewer wave result.')) {
          handlers.onTextDelta('RESULT: Independent reviewer complete.');
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Exercise delayed and blocked worker wave.',
      });
      expect(runResponse.status).toBe(202);

      await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        messages: Array<{ message_id: string; kind: string; content: string }>;
        deliveries: Array<{ message_id: string; status: string }>;
      }>;
      expect(runs[0].run.status).toBe('completed');

      const messageById = new Map(runs[0].messages.map((message) => [message.message_id, message]));
      const deliveryForAssignment = (assignmentId: string) =>
        runs[0].deliveries.find((delivery) => messageById.get(delivery.message_id)?.content.includes(`Assignment ${assignmentId}`));

      expect(flakyAttempts).toBe(2);
      expect(deliveryForAssignment('flaky-backend')?.status).toBe('done');
      expect(deliveryForAssignment('blocked-review')?.status).toBe('done');
      expect(deliveryForAssignment('independent-review')?.status).toBe('done');
      expect(leaderFollowUpPrompts).toHaveLength(1);
      expect(leaderFollowUpPrompts[0]).toContain('Flaky backend succeeded after retry.');
      expect(leaderFollowUpPrompts[0]).toContain('Blocked review ran after backend retry success.');
      expect(runs[0].messages.some((message) => message.kind === 'result' && message.content.includes('Independent reviewer complete.'))).toBe(true);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('repairs a leader final JSON object with prose, unescaped quotes, and literal newlines', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(`I can finish now.

{"type":"final","summary":"OpenAI的"刹车"","result":"双方强调"不是收购"。
第二行"}`);
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Summarize AI news.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );
      const completed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_completed' }> =>
          event.type === 'team_run_completed',
      );
      expect(completed!.final_message.content).toBe('双方强调"不是收购"。\n第二行');
      expect(completed!.run.status).toBe('completed');

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        messages: Array<{ kind: string; content: string }>;
      }>;
      expect(runs[0].messages.map((message) => message.kind)).toEqual(['user_request', 'final']);
      expect(runs[0].messages[1].content).toBe('双方强调"不是收购"。\n第二行');

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('retries leader parsing by asking for strict JSON when repair cannot infer a valid object', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta('type: final answer; summary: done');
        } else if (ctx.input.includes('Rewrite the same intent as exactly one strict JSON object.')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'done',
            result: 'Leader rewrote the answer as strict JSON.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Finish without delegation.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );
      const completed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_completed' }> =>
          event.type === 'team_run_completed',
      );
      expect(completed!.final_message.content).toBe('Leader rewrote the answer as strict JSON.');
      expect(fake.promptCalls.some((call) => call.input.includes('Previous response to rewrite:'))).toBe(true);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it.each([
    { output: 'RESULT: Implemented the endpoint.', expectedKind: 'result', expectedContent: 'Implemented the endpoint.', role: 'backend-coder' },
    { output: 'REVIEW: Looks good, tests pass.', expectedKind: 'review', expectedContent: 'Looks good, tests pass.', role: 'reviewer' },
    { output: 'NEED_INFO: Which database should store team state?', expectedKind: 'need_info', expectedContent: 'Which database should store team state?', role: 'backend-coder' },
    { output: 'PROPOSAL: Ask reviewer to inspect auth risk.', expectedKind: 'proposal', expectedContent: 'Ask reviewer to inspect auth risk.', role: 'backend-coder' },
    { output: 'FAILED: Build failed because migration is missing.', expectedKind: 'error', expectedContent: 'Build failed because migration is missing.', role: 'backend-coder' },
  ])(
    'routes $expectedKind member outbound messages back to leader',
    async ({ output, expectedKind, expectedContent, role }) => {
      const { db, fake, server, baseUrl } = await startServer();
      try {
        fake.promptScript = (handlers, ctx) => {
          if (ctx.input.includes('User request:')) {
            handlers.onTextDelta(JSON.stringify({
              type: 'plan',
              summary: `Send work to ${role}.`,
              assignments: [
                {
                  id: 'one-task',
                  to: role,
                  task: 'Do one task.',
                  context: 'Report back to leader.',
                  depends_on: [],
                },
              ],
            }));
          } else if (ctx.input.includes('New delivery:')) {
            handlers.onTextDelta(output);
          } else if (ctx.input.includes('New inbound team message:')) {
            handlers.onTextDelta(JSON.stringify({
              type: 'final',
              summary: 'Leader handled outbound.',
              result: 'Leader received the member outbound message.',
            }));
          }
          handlers.onStatusChange('completed');
        };

        const team = await createPlanningTeam(baseUrl);
        const leader = team.members.find((member) => member.role === 'leader')!;
        const worker = team.members.find((member) => member.role === role)!;
        const sseRes = await fetch(`${baseUrl}/api/events`);
        const reader = sseRes.body!.getReader();
        await sleep(30);

        const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
          text: `Create a ${expectedKind} message.`,
        });
        expect(runResponse.status).toBe(202);

        const events = await collectEvents(
          reader,
          (evs) =>
            evs.some((event) => event.type === 'team_message_created') &&
            evs.some((event) => event.type === 'team_run_completed'),
        );
        const routed = events.find(
          (event): event is Extract<ServerEvent, { type: 'team_message_created' }> =>
            event.type === 'team_message_created',
        );
        expect(routed).toBeTruthy();
        expect(routed!.message).toMatchObject({
          from_member_id: worker.member_id,
          from_kind: 'member',
          kind: expectedKind,
          content: expectedContent,
        });
        expect(routed!.delivery).toMatchObject({
          to_member_id: leader.member_id,
          status: 'pending',
          enqueue_seq: 2,
        });

        const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
          run: { status: string };
          messages: Array<{ kind: string; content: string; from_member_id: string | null }>;
          deliveries: Array<{ message_id: string; to_member_id: string; status: string; error: string | null }>;
        }>;
        expect(runs[0].run.status).toBe('completed');
        expect(runs[0].messages.some((message) => message.kind === expectedKind && message.content === expectedContent)).toBe(true);
        const originalDelivery = runs[0].deliveries.find((delivery) => delivery.to_member_id === worker.member_id)!;
        expect(originalDelivery.status).toBe(expectedKind === 'error' ? 'failed' : 'done');
        expect(originalDelivery.error).toBe(expectedKind === 'error' ? expectedContent : null);
        expect(runs[0].deliveries.some((delivery) => delivery.to_member_id === leader.member_id && delivery.status === 'done')).toBe(true);

        await reader.cancel();
      } finally {
        server.close();
        db.close();
      }
    },
  );

  it('surfaces attempted worker-to-worker messages to leader instead of delivering them directly', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Ask backend to coordinate review.',
            assignments: [
              {
                id: 'coordinate-review',
                to: 'backend-coder',
                task: 'Ask reviewer to inspect the API.',
                context: 'Use MESSAGE_TO if you think another member should act.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('New delivery:')) {
          handlers.onTextDelta('MESSAGE_TO reviewer: Please review the API route.');
        } else if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Handled reviewer proposal.',
            result: 'Leader saw the attempted direct reviewer message.',
          }));
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const leader = team.members.find((member) => member.role === 'leader')!;
      const backend = team.members.find((member) => member.role === 'backend-coder')!;
      const reviewer = team.members.find((member) => member.role === 'reviewer')!;
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Coordinate review.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) =>
          evs.some((event) => event.type === 'team_message_created') &&
          evs.some((event) => event.type === 'team_run_completed'),
      );
      const routed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_message_created' }> =>
          event.type === 'team_message_created',
      );
      expect(routed!.message).toMatchObject({
        from_member_id: backend.member_id,
        kind: 'proposal',
      });
      expect(routed!.message.content).toContain('Attempted message to reviewer.');
      expect(routed!.message.content).toContain('Please review the API route.');
      expect(routed!.delivery).toMatchObject({ to_member_id: leader.member_id, status: 'pending' });

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        deliveries: Array<{ to_member_id: string; status: string }>;
      }>;
      expect(runs[0].deliveries.filter((delivery) => delivery.to_member_id === reviewer.member_id)).toEqual([]);
      expect(runs[0].deliveries.filter((delivery) => delivery.to_member_id === leader.member_id && delivery.status === 'done')).toHaveLength(2);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('runs leader re-plan, reviewer review, and leader final in one sequential loop', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Implement first, then decide whether to review.',
            assignments: [
              {
                id: 'backend-work',
                to: 'backend-coder',
                task: 'Implement backend change.',
                context: 'Report concise result.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('New inbound team message:') && ctx.input.includes('Review passed')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Backend work was implemented and reviewed.',
            result: 'Backend change is complete and review passed.',
          }));
        } else if (ctx.input.includes('New inbound team message:') && ctx.input.includes('Backend done with tests.')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Review the backend result.',
            assignments: [
              {
                id: 'review-backend-work',
                to: 'reviewer',
                task: 'Review backend result.',
                context: 'Focus on regressions.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('Task:') && ctx.input.includes('Implement backend change.')) {
          handlers.onTextDelta('RESULT: Backend done with tests.');
        } else if (ctx.input.includes('Task:') && ctx.input.includes('Review backend result.')) {
          handlers.onTextDelta('REVIEW: Review passed; no regressions found.');
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Implement and review backend work.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_completed'),
      );
      expect(events.filter((event) => event.type === 'team_plan_created')).toHaveLength(2);
      const completed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_completed' }> =>
          event.type === 'team_run_completed',
      );
      expect(completed!.final_message.content).toBe('Backend change is complete and review passed.');
      expect(completed!.run.current_round).toBe(3);

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string; current_round: number };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ status: string }>;
      }>;
      expect(runs[0].run).toMatchObject({ status: 'completed', current_round: 3 });
      const messageKinds = runs[0].messages.map((message) => message.kind);
      expect(messageKinds.slice(0, 2)).toEqual(['user_request', 'status']);
      expect(messageKinds.filter((kind) => kind === 'assignment')).toHaveLength(2);
      expect(messageKinds.filter((kind) => kind === 'status')).toHaveLength(2);
      expect(messageKinds).toContain('result');
      expect(messageKinds).toContain('review');
      expect(messageKinds.at(-1)).toBe('final');
      expect(runs[0].deliveries.map((delivery) => delivery.status)).toEqual(['done', 'done', 'done', 'done', 'done']);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it('fails a run when leader re-plan loops exceed max_rounds', async () => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:') || ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Keep looping until max rounds stops us.',
            assignments: [
              {
                id: `loop-${fake.promptCalls.length}`,
                to: 'backend-coder',
                task: 'Loop once.',
                context: 'Return result.',
                depends_on: [],
              },
            ],
          }));
        } else if (ctx.input.includes('Task:') && ctx.input.includes('Loop once.')) {
          handlers.onTextDelta('RESULT: Loop result.');
        }
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Loop forever.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_failed'),
      );
      const failed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_failed' }> =>
          event.type === 'team_run_failed',
      );
      expect(failed!.error_message.content).toBe('team run exceeded max_rounds (8)');
      expect(failed!.run.status).toBe('failed');
      expect(failed!.run.current_round).toBe(8);

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string; current_round: number; max_rounds: number };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ status: string }>;
      }>;
      expect(runs[0].run).toMatchObject({ status: 'failed', current_round: 8, max_rounds: 8 });
      expect(runs[0].messages.at(-1)).toMatchObject({
        kind: 'error',
        content: 'team run exceeded max_rounds (8)',
      });
      expect(runs[0].deliveries.some((delivery) => delivery.status === 'failed')).toBe(true);

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it.each([
    {
      name: 'transient worker failure retries into a separate successful attempt',
      terminalFailures: 1,
      expectCompleted: true,
    },
    {
      name: 'transient worker failure exhaustion reports to leader',
      terminalFailures: 3,
      expectCompleted: false,
    },
  ])('$name', async ({ terminalFailures, expectCompleted }) => {
    const { db, fake, server, baseUrl } = await startServer({ deliveryRetryBackoffMs: [0, 0] });
    try {
      let backendAttempts = 0;
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'plan',
            summary: 'Try backend work with retryable failures.',
            assignments: [
              {
                id: 'backend',
                to: 'backend-coder',
                task: 'Implement retryable backend work.',
                context: 'Return a concise result.',
                depends_on: [],
              },
            ],
          }));
          handlers.onStatusChange('completed');
          return;
        }

        if (ctx.input.includes('New delivery:')) {
          backendAttempts += 1;
          handlers.onTextDelta(`partial attempt ${backendAttempts}`);
          if (backendAttempts <= terminalFailures) throw new Error(`request timeout ${backendAttempts}`);
          handlers.onTextDelta('RESULT: backend succeeded after retry.');
          handlers.onStatusChange('completed');
          return;
        }

        if (ctx.input.includes('New inbound team message:')) {
          handlers.onTextDelta(JSON.stringify({
            type: 'final',
            summary: 'Leader handled retry outcome.',
            result: 'Leader completed after reviewing worker outcome.',
          }));
          handlers.onStatusChange('completed');
        }
      };

      const team = await createPlanningTeam(baseUrl);
      const backend = team.members.find((member) => member.role === 'backend-coder')!;
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Exercise delivery retry.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(reader, (evs) => evs.some((event) => event.type === 'team_run_completed'));
      expect(events.filter((event) => event.type === 'team_delivery_status_change' && event.attempt_id)).not.toHaveLength(0);
      expect(backendAttempts).toBe(expectCompleted ? 2 : 3);

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        messages: Array<{ kind: string; content: string; from_member_id: string | null }>;
        deliveries: Array<{ delivery_id: string; to_member_id: string; status: string; error: string | null }>;
        attempts: Array<{
          attempt_id: string;
          delivery_id: string;
          attempt_number: number;
          status: string;
          output: string | null;
          error: string | null;
        }>;
      }>;
      const backendDelivery = runs[0].deliveries.find((delivery) => delivery.to_member_id === backend.member_id)!;
      const attempts = runs[0].attempts.filter((attempt) => attempt.delivery_id === backendDelivery.delivery_id);
      expect(attempts.map((attempt) => attempt.attempt_number)).toEqual(
        expectCompleted ? [1, 2] : [1, 2, 3],
      );
      expect(attempts.at(0)).toMatchObject({ status: 'failed', error: 'request timeout 1' });

      expect(attempts[0].output).toBeNull();
      expect(runs[0].messages.filter((message) => message.kind === 'error')).toHaveLength(expectCompleted ? 0 : 1);

      if (expectCompleted) {
        expect(backendDelivery).toMatchObject({ status: 'done', error: null });
        expect(attempts[1]).toMatchObject({ status: 'done', error: null });
        expect(attempts[1].output).toContain('partial attempt 2');
        expect(attempts[1].output).toContain('RESULT: backend succeeded after retry.');
      } else {
        expect(backendDelivery).toMatchObject({ status: 'failed', error: 'request timeout 3' });
        expect(attempts[2]).toMatchObject({ status: 'failed', error: 'request timeout 3' });
        expect(attempts[2].output).toContain('partial attempt 3');
        expect(runs[0].messages.some((message) => message.kind === 'error' && message.content === 'request timeout 3')).toBe(true);
      }

      await reader.cancel();
    } finally {
      server.close();
      db.close();
    }
  });

  it.each([
    {
      name: 'invalid JSON',
      output: '{"type":"plan","summary":',
      error: 'leader response was not valid JSON',
    },
    {
      name: 'unknown role',
      output: JSON.stringify({
        type: 'plan',
        summary: 'Bad role.',
        assignments: [{ id: 'ghost', to: 'designer', task: 'Design it.', context: '', depends_on: [] }],
      }),
      error: 'unknown assignment target role: designer. Available roles: leader, backend-coder, reviewer',
    },
    {
      name: 'bad dependency',
      output: JSON.stringify({
        type: 'plan',
        summary: 'Bad dependency.',
        assignments: [
          { id: 'review', to: 'reviewer', task: 'Review it.', context: '', depends_on: ['missing'] },
        ],
      }),
      error: 'assignment review depends on unknown assignment: missing',
    },
  ])('fails planning for $name without creating worker deliveries', async ({ output, error }) => {
    const { db, fake, server, baseUrl } = await startServer();
    try {
      fake.promptScript = (handlers, ctx) => {
        if (ctx.input.includes('User request:')) handlers.onTextDelta(output);
        handlers.onStatusChange('completed');
      };

      const team = await createPlanningTeam(baseUrl);
      const sseRes = await fetch(`${baseUrl}/api/events`);
      const reader = sseRes.body!.getReader();
      await sleep(30);

      const runResponse = await post(baseUrl, `/api/teams/${team.team_id}/runs`, {
        text: 'Plan something invalid.',
      });
      expect(runResponse.status).toBe(202);

      const events = await collectEvents(
        reader,
        (evs) => evs.some((event) => event.type === 'team_run_failed'),
      );
      const failed = events.find(
        (event): event is Extract<ServerEvent, { type: 'team_run_failed' }> =>
          event.type === 'team_run_failed',
      );
      expect(failed!.error_message.content).toBe(error);

      const runs = await (await fetch(`${baseUrl}/api/teams/${team.team_id}/runs`)).json() as Array<{
        run: { status: string };
        messages: Array<{ kind: string; content: string }>;
        deliveries: Array<{ status: string }>;
        dependencies: unknown[];
      }>;
      expect(runs[0].run.status).toBe('failed');
      expect(runs[0].messages.map((message) => message.kind)).toEqual(['user_request', 'error']);
      expect(runs[0].messages[1].content).toBe(error);
      expect(runs[0].deliveries).toHaveLength(1);
      expect(runs[0].deliveries[0].status).toBe('failed');
      expect(runs[0].dependencies).toEqual([]);

      await reader.cancel();
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
