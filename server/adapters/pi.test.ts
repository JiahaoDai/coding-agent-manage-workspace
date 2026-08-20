import { describe, expect, it, vi } from 'vitest';
import type { PromptHandlers } from '../../shared/adapter';
import type { Message } from '../../shared/session';
import {
  mapPiEvent,
  PiAdapter,
  transcriptMessages,
  type PiAgentEvent,
  type PiNativeSession,
  type PiSessionHandle,
  type PiSdk,
  type PermissionResolver,
} from './pi';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

/** The message-carrying member of the session-entry union. */
type SessionMessage = Extract<SessionEntry, { type: 'message' }>['message'];

/** Fixtures for the events a real Pi `AgentSession` emits (slim adapter shape). */

function textDelta(text: string): PiAgentEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } };
}

function thinkingDelta(text: string): PiAgentEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: text } };
}

function toolStart(callId: string, tool: string, args: unknown = {}): PiAgentEvent {
  return { type: 'tool_execution_start', toolCallId: callId, toolName: tool, args };
}

function toolEnd(callId: string, isError = false): PiAgentEvent {
  return { type: 'tool_execution_end', toolCallId: callId, toolName: 'bash', result: {}, isError };
}

function retry(attempt: number, message: string): PiAgentEvent {
  return { type: 'auto_retry_start', attempt, maxAttempts: 3, errorMessage: message };
}

/** A PromptHandlers whose calls are recorded, with a scripted permission answer. */
function spyHandlers(decision: 'allow' | 'deny' = 'allow') {
  const handlers = {
    onTextDelta: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onThinkingDelta: vi.fn(),
    onStatusNote: vi.fn(),
    onStatusChange: vi.fn(),
    onPermissionRequest: vi.fn(async () => decision),
  } satisfies PromptHandlers & {
    onPermissionRequest: (request_id: string, tool_name: string, input: unknown) => Promise<'allow' | 'deny'>;
  };
  return handlers;
}

describe('mapPiEvent (Pi event → handlers)', () => {
  it('streams text and thinking deltas incrementally', () => {
    const handlers = spyHandlers();
    mapPiEvent(textDelta('Hello '), handlers);
    mapPiEvent(textDelta('world'), handlers);
    mapPiEvent(thinkingDelta('hmm'), handlers);

    expect(handlers.onTextDelta.mock.calls.map((c) => c[0])).toEqual(['Hello ', 'world']);
    expect(handlers.onThinkingDelta.mock.calls.map((c) => c[0])).toEqual(['hmm']);
  });

  it('emits tool call start and end from the execution lifecycle', () => {
    const handlers = spyHandlers();
    mapPiEvent(toolStart('call-1', 'bash', { command: 'ls' }), handlers);
    mapPiEvent(toolStart('call-2', 'bash', { command: 'pwd' }), handlers);
    mapPiEvent(toolEnd('call-1'), handlers);

    expect(handlers.onToolCallStart.mock.calls).toEqual([
      ['call-1', 'bash', { command: 'ls' }],
      ['call-2', 'bash', { command: 'pwd' }],
    ]);
    expect(handlers.onToolCallEnd).toHaveBeenCalledWith('call-1');
    expect(handlers.onToolCallEnd).not.toHaveBeenCalledWith('call-2');
  });

  it('defaults missing tool args to an empty object', () => {
    const handlers = spyHandlers();
    mapPiEvent(toolStart('call-1', 'write'), handlers);
    expect(handlers.onToolCallStart).toHaveBeenCalledWith('call-1', 'write', {});
  });

  it('surfaces provider retries as a status note', () => {
    const handlers = spyHandlers();
    mapPiEvent(retry(2, 'rate limited'), handlers);
    expect(handlers.onStatusNote).toHaveBeenCalledWith('Pi retrying (attempt 2/3): rate limited');
    expect(handlers.onTextDelta).not.toHaveBeenCalled();
  });
});

/** A scripted PiSessionHandle that records what it was driven with. */
function makeHandle(opts: {
  events?: PiAgentEvent[];
  /** isStreaming() returns this (default false). */
  streaming?: boolean;
  /** prompt rejects with this (default none). */
  promptError?: Error;
} = {}) {
  const listeners = new Set<(event: PiAgentEvent) => void>();
  let resolver: PermissionResolver | undefined;
  const prompts: string[] = [];

  const handle: PiSessionHandle = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isStreaming: () => opts.streaming ?? false,
    setPermissionResolver(r) {
      resolver = r;
    },
    async prompt(input) {
      prompts.push(input);
      if (opts.promptError) throw opts.promptError;
      for (const event of opts.events ?? []) {
        for (const listener of listeners) listener(event);
      }
    },
  };

  return {
    handle,
    prompts,
    /** The resolver the adapter wired up on the last turn, if any. */
    resolver: () => resolver,
  };
}

/** A scripted PiSdk that records the native sessions it was driven with. */
function makeSdk(opts: {
  handle?: PiSessionHandle;
  sessions?: PiNativeSession[];
  transcript?: Message[];
} = {}) {
  const openCalls: Array<{ id: string; cwd: string }> = [];
  const createCalls: Array<{ cwd: string; name?: string }> = [];

  const sdk: PiSdk = {
    async createSession(cwd, opts) {
      createCalls.push({ cwd, name: opts?.name });
      return { real_session_id: '/tmp/p/ses-created.jsonl' };
    },
    async openSession(real_session_id, cwd) {
      openCalls.push({ id: real_session_id, cwd });
      if (!opts.handle) throw new Error('openSession called without a scripted handle');
      return opts.handle;
    },
    async listSessions() {
      return opts.sessions ?? [];
    },
    async getMessages() {
      return opts.transcript ?? [];
    },
  };

  return { sdk, openCalls, createCalls };
}

describe('PiAdapter', () => {
  it('createSession returns the native session file path', async () => {
    const { sdk, createCalls } = makeSdk({ handle: makeHandle().handle });
    const adapter = new PiAdapter(sdk);

    expect(await adapter.createSession('/tmp/p', { name: 'fix auth' })).toEqual({
      real_session_id: '/tmp/p/ses-created.jsonl',
    });
    expect(createCalls).toEqual([{ cwd: '/tmp/p', name: 'fix auth' }]);
  });

  it('openSession opens the native session (idempotent resume)', async () => {
    const { sdk, openCalls } = makeSdk({ handle: makeHandle().handle });
    const adapter = new PiAdapter(sdk);

    expect(await adapter.openSession('/tmp/p/s1.jsonl', '/tmp/p')).toEqual({
      real_session_id: '/tmp/p/s1.jsonl',
    });
    expect(openCalls).toEqual([{ id: '/tmp/p/s1.jsonl', cwd: '/tmp/p' }]);
  });

  it('maps native session metadata for create-time resume', async () => {
    const { sdk } = makeSdk({
      sessions: [
        { path: '/tmp/p/s1.jsonl', id: 's1', cwd: '/tmp/p', firstMessage: 'Fix auth', modified: new Date(100) },
        { path: '/tmp/p/s2.jsonl', id: 's2', cwd: '', name: 'do the thing', firstMessage: '', modified: new Date(200) },
      ],
    });
    const adapter = new PiAdapter(sdk);

    expect(await adapter.listSessions('/tmp/p')).toEqual([
      { real_session_id: '/tmp/p/s1.jsonl', summary: 'Fix auth', cwd: '/tmp/p', modify_time: 100 },
      { real_session_id: '/tmp/p/s2.jsonl', summary: 'do the thing', cwd: '/tmp/p', modify_time: 200 },
    ]);
  });

  it('delegates message-history reads to the native store', async () => {
    const { sdk } = makeSdk({ transcript: [{ role: 'user', content: 'hello' }] });
    const adapter = new PiAdapter(sdk);

    expect(await adapter.getMessages('/tmp/p/s1.jsonl', '/tmp/p')).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('streams a scripted turn and marks completed', async () => {
    const h = makeHandle({
      events: [textDelta('Hello '), textDelta('world'), thinkingDelta('hmm'), toolStart('call-1', 'bash', { command: 'ls' }), toolEnd('call-1')],
    });
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'hi', handlers);

    expect(h.prompts).toEqual(['hi']);
    expect(handlers.onTextDelta.mock.calls.map((c) => c[0])).toEqual(['Hello ', 'world']);
    expect(handlers.onThinkingDelta.mock.calls.map((c) => c[0])).toEqual(['hmm']);
    expect(handlers.onToolCallStart).toHaveBeenCalledWith('call-1', 'bash', { command: 'ls' });
    expect(handlers.onToolCallEnd).toHaveBeenCalledWith('call-1');
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('rejects when the session is already streaming (no silent queueing)', async () => {
    const h = makeHandle({ streaming: true });
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);

    await expect(adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'hi', spyHandlers())).rejects.toThrow(
      'already busy',
    );
    expect(h.prompts).toEqual([]);
  });

  it('rejects when the prompt itself fails', async () => {
    const h = makeHandle({ promptError: new Error('provider down') });
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);

    await expect(adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'hi', spyHandlers())).rejects.toThrow(
      'provider down',
    );
  });

  it('routes an allow through the permission resolver', async () => {
    const h = makeHandle();
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);
    const handlers = spyHandlers('allow');

    await adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'edit a file', handlers);

    const resolver = h.resolver();
    expect(resolver).toBeDefined();
    const decision = await resolver!('req-1', 'edit', { path: 'a.ts' });
    expect(decision).toBe('allow');
    expect(handlers.onPermissionRequest).toHaveBeenCalledWith('req-1', 'edit', { path: 'a.ts' });
  });

  it('routes a deny through the permission resolver', async () => {
    const h = makeHandle();
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);
    const handlers = spyHandlers('deny');

    await adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'edit a file', handlers);

    const decision = await h.resolver()!('req-1', 'bash', { command: 'rm -rf /' });
    expect(decision).toBe('deny');
  });

  it('does not emit completed when the turn rejects', async () => {
    const h = makeHandle({ promptError: new Error('boom') });
    const { sdk } = makeSdk({ handle: h.handle });
    const adapter = new PiAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('/tmp/p/s1.jsonl', '/tmp/p', 'hi', handlers).catch(() => {});

    expect(handlers.onStatusChange).not.toHaveBeenCalled();
  });
});

describe('transcriptMessages', () => {
  function messageEntry(role: 'user' | 'assistant', content: unknown): SessionEntry {
    return {
      type: 'message',
      id: `id-${role}`,
      parentId: null,
      timestamp: '2026-08-20T00:00:00.000Z',
      message: { role, content } as SessionMessage,
    } as SessionEntry;
  }

  it('reads user and assistant text from stored entries', () => {
    const entries: SessionEntry[] = [
      messageEntry('user', 'hello'),
      messageEntry('assistant', [{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }]),
    ];
    expect(transcriptMessages(entries)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('skips tool results and non-message entries', () => {
    const entries: SessionEntry[] = [
      messageEntry('user', 'hi'),
      {
        type: 'message',
        id: 'id-tool',
        parentId: null,
        timestamp: 't',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'ls output' }] },
      } as unknown as SessionEntry,
      { type: 'model_change', id: 'm1', parentId: null, timestamp: 't', provider: 'p', modelId: 'm' } as SessionEntry,
    ];
    expect(transcriptMessages(entries)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('returns null-free entries only when there is text', () => {
    expect(transcriptMessages([messageEntry('user', [])])).toEqual([]);
  });
});
