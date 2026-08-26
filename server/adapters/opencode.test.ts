import { describe, expect, it, vi } from 'vitest';
import type { PromptHandlers } from '../../shared/adapter';
import type { Message } from '../../shared/session';
import {
  createOpencodeSdk,
  mapOpencodeEvent,
  opencodeErrorDetail,
  OpenCodeAdapter,
  type OpencodeEvent,
  type OpencodeEventState,
  type OpencodeNativeSession,
  type OpencodePermission,
  type OpencodePermissionV2,
  type OpencodeSdk,
  type OpencodeTranscriptEntry,
} from './opencode';
import type { OpenCodeRuntime } from './opencode';

/**
 * Fixtures for the events a real `opencode serve` emits. These are the live
 * server's shapes (message.part.delta / permission.asked), not the
 * `@opencode-ai/sdk` generated types, which lag the server on streaming and
 * permission event names.
 */

function textDelta(text: string, opts: { sessionID?: string; field?: string } = {}): OpencodeEvent {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: opts.sessionID ?? 'ses-1',
      messageID: 'msg-1',
      partID: 'prt-1',
      field: opts.field ?? 'text',
      delta: text,
    },
  };
}

function thinkingDelta(text: string): OpencodeEvent {
  return textDelta(text, { field: 'reasoning' });
}

function toolPartUpdate(
  id: string,
  callID: string,
  tool: string,
  status: 'pending' | 'running' | 'completed' | 'error',
  input: Record<string, unknown> = {},
): OpencodeEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses-1',
      part: { type: 'tool', id, callID, tool, state: { status, input } },
    },
  };
}

function idle(sessionID = 'ses-1'): OpencodeEvent {
  return { type: 'session.idle', properties: { sessionID } };
}

function retryStatus(attempt: number, message: string): OpencodeEvent {
  return {
    type: 'session.status',
    properties: { sessionID: 'ses-1', status: { type: 'retry', attempt, message, next: 1000 } },
  };
}

function busyStatus(): OpencodeEvent {
  return {
    type: 'session.status',
    properties: { sessionID: 'ses-1', status: { type: 'busy' } },
  };
}

function sessionError(message = 'boom'): OpencodeEvent {
  return {
    type: 'session.error',
    properties: { sessionID: 'ses-1', error: { name: 'UnknownError', data: { message } } },
  };
}

function permissionAsked(overrides: Partial<OpencodePermission> = {}): OpencodeEvent {
  return {
    type: 'permission.asked',
    properties: {
      id: 'per-1',
      sessionID: 'ses-1',
      permission: 'bash',
      patterns: ['*'],
      metadata: { command: 'ls -la' },
      always: [],
      tool: { messageID: 'msg-1', callID: 'call-1' },
      ...overrides,
    },
  };
}

function permissionV2Asked(overrides: Partial<OpencodePermissionV2> = {}): OpencodeEvent {
  return {
    type: 'permission.v2.asked',
    properties: {
      id: 'per-2',
      sessionID: 'ses-1',
      action: 'edit',
      resources: ['a.ts'],
      save: [],
      metadata: {},
      source: { type: 'tool', messageID: 'msg-1', callID: 'call-2' },
      ...overrides,
    },
  };
}

async function* eventsFrom(events: OpencodeEvent[]): AsyncGenerator<OpencodeEvent> {
  for (const event of events) yield event;
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

function freshState(): OpencodeEventState {
  return { startedToolParts: new Set() };
}

describe('mapOpencodeEvent (server event → handlers)', () => {
  it('streams text and thinking deltas incrementally', () => {
    const handlers = spyHandlers();
    mapOpencodeEvent(textDelta('Hello '), 'ses-1', handlers, freshState());
    mapOpencodeEvent(textDelta('world'), 'ses-1', handlers, freshState());
    mapOpencodeEvent(thinkingDelta('hmm'), 'ses-1', handlers, freshState());

    expect(handlers.onTextDelta.mock.calls.map((c) => c[0])).toEqual(['Hello ', 'world']);
    expect(handlers.onThinkingDelta.mock.calls.map((c) => c[0])).toEqual(['hmm']);
  });

  it('ignores deltas for other fields and other sessions', () => {
    const handlers = spyHandlers();
    mapOpencodeEvent(textDelta('input json', { field: 'input' }), 'ses-1', handlers, freshState());
    mapOpencodeEvent(textDelta('not mine', { sessionID: 'ses-2' }), 'ses-1', handlers, freshState());

    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onThinkingDelta).not.toHaveBeenCalled();
  });

  it('emits a tool call start once, then end, from state snapshots', () => {
    const handlers = spyHandlers();
    const state = freshState();

    mapOpencodeEvent(toolPartUpdate('prt-t', 'call-1', 'bash', 'running', { command: 'ls' }), 'ses-1', handlers, state);
    mapOpencodeEvent(toolPartUpdate('prt-t', 'call-1', 'bash', 'running', { command: 'ls' }), 'ses-1', handlers, state);
    mapOpencodeEvent(toolPartUpdate('prt-t', 'call-1', 'bash', 'completed', { command: 'ls' }), 'ses-1', handlers, state);

    expect(handlers.onToolCallStart).toHaveBeenCalledTimes(1);
    expect(handlers.onToolCallStart).toHaveBeenCalledWith('call-1', 'bash', { command: 'ls' });
    expect(handlers.onToolCallEnd).toHaveBeenCalledWith('call-1');
  });

  it('does not replay text/thinking from part snapshots (deltas are the stream)', () => {
    const handlers = spyHandlers();
    mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses-1',
          part: { type: 'text', text: 'full text' },
        },
      },
      'ses-1',
      handlers,
      freshState(),
    );
    mapOpencodeEvent(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses-1',
          part: { type: 'reasoning', text: 'full thinking' },
        },
      },
      'ses-1',
      handlers,
      freshState(),
    );

    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onThinkingDelta).not.toHaveBeenCalled();
  });

  it('ignores permission and lifecycle events (the adapter handles those)', () => {
    const handlers = spyHandlers();
    mapOpencodeEvent(permissionAsked(), 'ses-1', handlers, freshState());
    mapOpencodeEvent(idle(), 'ses-1', handlers, freshState());

    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onToolCallStart).not.toHaveBeenCalled();
  });
});

describe('opencodeErrorDetail', () => {
  it('formats a named error with a message', () => {
    expect(opencodeErrorDetail({ name: 'UnknownError', data: { message: 'boom' } })).toBe('UnknownError: boom');
  });

  it('falls back gracefully', () => {
    expect(opencodeErrorDetail()).toBe('OpenCode turn ended with an error');
    expect(opencodeErrorDetail({ name: 'ProviderAuthError' })).toBe('ProviderAuthError');
  });
});

/** A scripted OpencodeSdk that records what it was driven with. */
function makeSdk(opts: {
  events?: OpencodeEvent[];
  promptError?: Error;
  /** If true, prompt never resolves (e.g. the server's POST hangs in a retry loop). */
  hangPrompt?: boolean;
  sessions?: OpencodeNativeSession[];
  transcript?: OpencodeTranscriptEntry[];
} = {}) {
  const promptCalls: Array<{ sessionID: string; cwd: string; input: string }> = [];
  const permissionReplies: Array<{
    sessionID: string;
    permissionID: string;
    response: 'once' | 'always' | 'reject';
  }> = [];

  const sdk: OpencodeSdk = {
    async subscribe() {
      return eventsFrom(opts.events ?? []);
    },
    async createSession() {
      return { id: 'ses-created' };
    },
    async listSessions() {
      return opts.sessions ?? [];
    },
    async getMessages() {
      return opts.transcript ?? [];
    },
    async prompt(sessionID, cwd, input) {
      promptCalls.push({ sessionID, cwd, input });
      if (opts.hangPrompt) return new Promise<never>(() => {});
      if (opts.promptError) throw opts.promptError;
      return { info: { id: 'msg-1', sessionID, role: 'assistant' }, parts: [] };
    },
    async replyPermission(sessionID, permissionID, response) {
      permissionReplies.push({ sessionID, permissionID, response });
    },
  };

  return { sdk, promptCalls, permissionReplies };
}

describe('OpenCodeAdapter', () => {
  it('shares one initial server spawn across concurrent model discovery requests', async () => {
    let resolveServer!: (server: { url: string; close(): void }) => void;
    const createServer = vi.fn(() => new Promise<{ url: string; close(): void }>((resolve) => { resolveServer = resolve; }));
    const runtime: OpenCodeRuntime = {
      createServer,
      createClient: vi.fn(() => ({ config: { providers: vi.fn(async () => ({ data: { providers: [] } })) } }) as never),
    };
    const sdk = createOpencodeSdk({}, runtime);
    const first = sdk.listModels!('/project');
    const second = sdk.listModels!('/project');
    expect(createServer).toHaveBeenCalledTimes(1);
    expect(createServer).toHaveBeenCalledWith({ port: 9999 });
    resolveServer({ url: 'http://127.0.0.1:9999', close() {} });
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it('closes the OpenCode server it spawned', async () => {
    const previousUrl = process.env.OPENCODE_URL;
    delete process.env.OPENCODE_URL;
    const close = vi.fn();
    const runtime: OpenCodeRuntime = {
      createServer: vi.fn(async () => ({ url: 'http://127.0.0.1:9999', close })),
      createClient: vi.fn(() => ({ config: { providers: vi.fn(async () => ({ data: { providers: [] } })) } }) as never),
    };
    const sdk = createOpencodeSdk({}, runtime);

    try {
      await sdk.listModels!('/project');
      await sdk.close?.();
      await sdk.close?.();
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousUrl;
    }

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('createSession returns the native session id', async () => {
    const adapter = new OpenCodeAdapter(makeSdk().sdk);
    expect(await adapter.createSession('/tmp/p', { name: 'fix auth' })).toEqual({
      real_session_id: 'ses-created',
    });
  });

  it('maps native session metadata for create-time resume', async () => {
    const { sdk } = makeSdk({
      sessions: [
        { id: 's1', title: 'Fix auth', directory: '/tmp/p', time: { updated: 100 } },
        { id: 's2', title: 'do the thing' },
      ],
    });
    const adapter = new OpenCodeAdapter(sdk);

    expect(await adapter.listSessions('/tmp/p')).toEqual([
      { real_session_id: 's1', summary: 'Fix auth', cwd: '/tmp/p', modify_time: 100 },
      { real_session_id: 's2', summary: 'do the thing', cwd: '/tmp/p', modify_time: undefined },
    ]);
  });

  it('reads message history from the native transcript as text', async () => {
    const { sdk } = makeSdk({
      transcript: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'hi ' },
            { type: 'text', text: 'there' },
            { type: 'reasoning', text: 'thinking stays collapsed' },
            { type: 'tool', id: 'prt-t', callID: 'call-1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } },
          ],
        },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'synthetic bit', synthetic: true }] },
        { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: 'only reasoning' }] },
      ],
    });
    const adapter = new OpenCodeAdapter(sdk);

    const messages: Message[] = await adapter.getMessages('s1', '/tmp/p');
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('streams a scripted turn and marks completed', async () => {
    const { sdk } = makeSdk({ events: [textDelta('Hello '), textDelta('world'), thinkingDelta('hmm'), idle()] });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onTextDelta.mock.calls.map((c) => c[0])).toEqual(['Hello ', 'world']);
    expect(handlers.onThinkingDelta.mock.calls.map((c) => c[0])).toEqual(['hmm']);
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('streams tool call state transitions', async () => {
    const { sdk } = makeSdk({
      events: [
        toolPartUpdate('prt-t', 'call-1', 'bash', 'running', { command: 'ls' }),
        toolPartUpdate('prt-t', 'call-1', 'bash', 'completed', { command: 'ls' }),
        idle(),
      ],
    });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onToolCallStart).toHaveBeenCalledWith('call-1', 'bash', { command: 'ls' });
    expect(handlers.onToolCallEnd).toHaveBeenCalledWith('call-1');
  });

  it('completes when the event stream ends without an idle event', async () => {
    const { sdk } = makeSdk({ events: [textDelta('ok')] });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onTextDelta).toHaveBeenCalledWith('ok');
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('routes an allow through the permission reply as "once"', async () => {
    const { sdk, permissionReplies } = makeSdk({ events: [permissionAsked()] });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers('allow');

    await adapter.prompt('ses-1', '/tmp/p', 'run ls', handlers);

    expect(handlers.onPermissionRequest).toHaveBeenCalledWith('per-1', 'bash', { command: 'ls -la' });
    expect(permissionReplies).toEqual([{ sessionID: 'ses-1', permissionID: 'per-1', response: 'once' }]);
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('routes a deny through the permission reply as "reject"', async () => {
    const { sdk, permissionReplies } = makeSdk({ events: [permissionAsked()] });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers('deny');

    await adapter.prompt('ses-1', '/tmp/p', 'run ls', handlers);

    expect(permissionReplies).toEqual([{ sessionID: 'ses-1', permissionID: 'per-1', response: 'reject' }]);
  });

  it('answers v2 permission requests too', async () => {
    const { sdk, permissionReplies } = makeSdk({ events: [permissionV2Asked()] });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers('allow');

    await adapter.prompt('ses-1', '/tmp/p', 'edit a file', handlers);

    expect(handlers.onPermissionRequest).toHaveBeenCalledWith('per-2', 'edit', { resources: ['a.ts'] });
    expect(permissionReplies).toEqual([{ sessionID: 'ses-1', permissionID: 'per-2', response: 'once' }]);
  });

  it('sends every turn to the same session id (re-prompt resume)', async () => {
    const { sdk, promptCalls } = makeSdk({ events: [idle(), idle()] });
    const adapter = new OpenCodeAdapter(sdk);

    await adapter.prompt('ses-1', '/tmp/p', 'first', spyHandlers());
    await adapter.prompt('ses-1', '/tmp/p', 'second', spyHandlers());

    expect(promptCalls).toEqual([
      { sessionID: 'ses-1', cwd: '/tmp/p', input: 'first' },
      { sessionID: 'ses-1', cwd: '/tmp/p', input: 'second' },
    ]);
  });

  it('rejects when the server reports a session error', async () => {
    const { sdk } = makeSdk({ events: [sessionError('boom')] });
    const adapter = new OpenCodeAdapter(sdk);

    await expect(adapter.prompt('ses-1', '/tmp/p', 'hi', spyHandlers())).rejects.toThrow('UnknownError: boom');
  });

  it('rejects when the prompt call itself fails', async () => {
    const { sdk } = makeSdk({ promptError: new Error('server down') });
    const adapter = new OpenCodeAdapter(sdk);

    await expect(adapter.prompt('ses-1', '/tmp/p', 'hi', spyHandlers())).rejects.toThrow('server down');
  });

  it('ignores events for other sessions', async () => {
    const { sdk } = makeSdk({
      events: [textDelta('other session', { sessionID: 'ses-2' }), idle('ses-2')],
    });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('surfaces rate-limit retries as a status note instead of silence', async () => {
    const { sdk } = makeSdk({
      events: [busyStatus(), retryStatus(1, 'Free usage exceeded, subscribe to Go'), textDelta('ok'), idle()],
    });
    const adapter = new OpenCodeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onStatusNote).toHaveBeenCalledWith(
      'OpenCode retrying (attempt 1): Free usage exceeded, subscribe to Go',
    );
    expect(handlers.onTextDelta).toHaveBeenCalledWith('ok');
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('fails a turn that only retries without progress', async () => {
    vi.useFakeTimers();
    try {
      const { sdk } = makeSdk({
        events: [retryStatus(1, 'Free usage exceeded'), retryStatus(2, 'Free usage exceeded')],
        hangPrompt: true,
      });
      const adapter = new OpenCodeAdapter(sdk, 5000, 30000);
      const handlers = spyHandlers();

      const turn = adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);
      // Attach the rejection assertion before advancing timers so the stall
      // rejection is handled as soon as it fires, not a tick later.
      const assertion = expect(turn).rejects.toThrow(
        'OpenCode turn stalled — no output for 30s (last status: Free usage exceeded)',
      );
      await vi.advanceTimersByTimeAsync(31000);

      await assertion;
      expect(handlers.onStatusNote).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stall while a permission decision is pending', async () => {
    vi.useFakeTimers();
    try {
      const { sdk } = makeSdk({ events: [permissionAsked()], hangPrompt: true });
      const adapter = new OpenCodeAdapter(sdk, 5000, 30000);
      let resolveDecision!: (decision: 'allow' | 'deny') => void;
      const decision = new Promise<'allow' | 'deny'>((resolve) => (resolveDecision = resolve));
      const handlers = spyHandlers();
      handlers.onPermissionRequest = vi.fn(() => decision);

      const turn = adapter.prompt('ses-1', '/tmp/p', 'hi', handlers);
      let failed = false;
      turn.catch(() => (failed = true));

      // Past the stall window while the user is deciding: the turn must not
      // have failed.
      await vi.advanceTimersByTimeAsync(40000);
      expect(failed).toBe(false);

      resolveDecision('allow');
      // Still waiting on the hung prompt POST, but not because of a stall:
      // the stall timer resumed from the answer, so this window is short.
      await vi.advanceTimersByTimeAsync(5000);
      expect(failed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
