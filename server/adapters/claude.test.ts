import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PromptHandlers } from '../../shared/adapter';
import type { Message } from '../../shared/session';
import { ClaudeAdapter, mapClaudeMessage, type ClaudeSdk } from './claude';

/**
 * Scripted fixtures for the SDK message union. Real Claude Code messages carry
 * many more fields; these are cast down to the parts the adapter actually reads,
 * so the mapping is tested against realistic shapes without spawning an agent.
 */

function textDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKMessage;
}

function thinkingDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKMessage;
}

function assistantMessage(blocks: unknown[]): SDKMessage {
  return {
    type: 'assistant',
    message: { content: blocks },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKMessage;
}

function resultSuccess(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
  } as unknown as SDKMessage;
}

function resultError(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['boom'],
  } as unknown as SDKMessage;
}

/** A PromptHandlers whose calls are recorded, with a scripted permission answer. */
function spyHandlers(decision: 'allow' | 'deny' = 'allow') {
  const handlers = {
    onTextDelta: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallEnd: vi.fn(),
    onThinkingDelta: vi.fn(),
    onStatusChange: vi.fn(),
    onPermissionRequest: vi.fn(async () => decision),
  } satisfies PromptHandlers & {
    onPermissionRequest: (request_id: string, tool_name: string, input: unknown) => Promise<'allow' | 'deny'>;
  };
  return handlers;
}

describe('mapClaudeMessage (SDK message → handlers)', () => {
  it('streams text and thinking deltas incrementally', () => {
    const handlers = spyHandlers();
    mapClaudeMessage(textDelta('Hello '), handlers);
    mapClaudeMessage(textDelta('world'), handlers);
    mapClaudeMessage(thinkingDelta('hmm'), handlers);

    expect(handlers.onTextDelta.mock.calls.map((c) => c[0])).toEqual(['Hello ', 'world']);
    expect(handlers.onThinkingDelta.mock.calls.map((c) => c[0])).toEqual(['hmm']);
    expect(handlers.onToolCallStart).not.toHaveBeenCalled();
  });

  it('emits tool calls from the complete assistant message with full input', () => {
    const handlers = spyHandlers();
    mapClaudeMessage(
      assistantMessage([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]),
      handlers,
    );

    expect(handlers.onToolCallStart).toHaveBeenCalledWith('t1', 'Bash', { command: 'ls -la' });
    expect(handlers.onToolCallEnd).toHaveBeenCalledWith('t1');
  });

  it('does not re-emit assistant text/thinking that already streamed as deltas', () => {
    const handlers = spyHandlers();
    mapClaudeMessage(
      assistantMessage([{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 'x' }]),
      handlers,
    );

    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onThinkingDelta).not.toHaveBeenCalled();
    expect(handlers.onToolCallStart).not.toHaveBeenCalled();
  });

  it('marks completed on a successful result', () => {
    const handlers = spyHandlers();
    mapClaudeMessage(resultSuccess(), handlers);
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('throws on an error result so the server marks the session error', () => {
    const handlers = spyHandlers();
    expect(() => mapClaudeMessage(resultError(), handlers)).toThrow('boom');
    expect(handlers.onStatusChange).not.toHaveBeenCalled();
  });

  it('ignores system, user, and other informational messages', () => {
    const handlers = spyHandlers();
    mapClaudeMessage({ type: 'system', subtype: 'init' } as unknown as SDKMessage, handlers);
    mapClaudeMessage({ type: 'user', message: {} } as unknown as SDKMessage, handlers);
    expect(handlers.onTextDelta).not.toHaveBeenCalled();
    expect(handlers.onStatusChange).not.toHaveBeenCalled();
  });
});

/** A scripted ClaudeSdk that records the query options it was driven with. */
function makeSdk(messages: SDKMessage[] = []) {
  const calls: Array<{ prompt: string; options?: Options }> = [];
  const permissions: unknown[] = [];
  let existing: SDKSessionInfo | undefined;
  let native: SDKSessionInfo[] = [];
  let transcript: SessionMessage[] = [];

  const permissionCtx = {
    signal: new AbortController().signal,
    toolUseID: 'tool-1',
    requestId: 'req-1',
  } as Parameters<NonNullable<Options['canUseTool']>>[2];

  const sdk: ClaudeSdk = {
    async getSessionInfo() {
      return existing;
    },
    async listSessions() {
      return native;
    },
    async getSessionMessages() {
      return transcript;
    },
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      // Drive the permission gate the way the real SDK does, so the adapter's
      // canUseTool wiring is observable.
      if (options?.canUseTool) {
        permissions.push(await options.canUseTool('Bash', { command: 'ls' }, permissionCtx));
      }
      for (const m of messages) yield m;
    },
  };

  return {
    sdk,
    calls,
    permissions,
    setExisting: (s: SDKSessionInfo | undefined) => {
      existing = s;
    },
    setNative: (s: SDKSessionInfo[]) => {
      native = s;
    },
    setTranscript: (s: SessionMessage[]) => {
      transcript = s;
    },
  };
}

const sessionInfo = (sessionId: string): SDKSessionInfo => ({
  sessionId,
  summary: 'a session',
  lastModified: 123,
});

describe('ClaudeAdapter', () => {
  it('createSession returns a fresh UUID as the real session id', async () => {
    const adapter = new ClaudeAdapter(makeSdk().sdk);
    const { real_session_id } = await adapter.createSession('/tmp/p');
    expect(real_session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('first turn creates the session with the pre-generated id', async () => {
    const { sdk, calls, setExisting } = makeSdk([resultSuccess()]);
    const adapter = new ClaudeAdapter(sdk);
    setExisting(undefined);

    await adapter.prompt('session-1', '/tmp/p', 'hi', spyHandlers());

    expect(calls).toHaveLength(1);
    const options = calls[0].options!;
    expect(options.sessionId).toBe('session-1');
    expect(options.resume).toBeUndefined();
    expect(options.cwd).toBe('/tmp/p');
    expect(options.permissionMode).toBe('default');
    expect(options.includePartialMessages).toBe(true);
  });

  it('later turns resume the existing native session', async () => {
    const { sdk, calls, setExisting } = makeSdk([resultSuccess()]);
    const adapter = new ClaudeAdapter(sdk);
    setExisting(sessionInfo('session-1'));

    await adapter.prompt('session-1', '/tmp/p', 'hi again', spyHandlers());

    const options = calls[0].options!;
    expect(options.resume).toBe('session-1');
    expect(options.sessionId).toBeUndefined();
  });

  it('routes an allow through canUseTool', async () => {
    const { sdk, permissions } = makeSdk([resultSuccess()]);
    const adapter = new ClaudeAdapter(sdk);
    const handlers = spyHandlers('allow');

    await adapter.prompt('session-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onPermissionRequest).toHaveBeenCalledWith('tool-1', 'Bash', { command: 'ls' });
    expect(permissions).toEqual([{ behavior: 'allow' }]);
  });

  it('routes a deny through canUseTool', async () => {
    const { sdk, permissions } = makeSdk([resultSuccess()]);
    const adapter = new ClaudeAdapter(sdk);
    const handlers = spyHandlers('deny');

    await adapter.prompt('session-1', '/tmp/p', 'hi', handlers);

    expect(permissions).toEqual([{ behavior: 'deny', message: 'Denied by user' }]);
  });

  it('streams a scripted turn and marks completed on result', async () => {
    const { sdk } = makeSdk([textDelta('hello'), resultSuccess()]);
    const adapter = new ClaudeAdapter(sdk);
    const handlers = spyHandlers();

    await adapter.prompt('session-1', '/tmp/p', 'hi', handlers);

    expect(handlers.onTextDelta).toHaveBeenCalledWith('hello');
    expect(handlers.onStatusChange).toHaveBeenCalledWith('completed');
  });

  it('maps native session metadata for create-time resume', async () => {
    const { sdk, setNative } = makeSdk();
    setNative([
      { sessionId: 's1', summary: 'Fix auth', lastModified: 100, cwd: '/tmp/p' },
      { sessionId: 's2', summary: '', lastModified: 200, firstPrompt: 'do the thing' },
    ]);
    const adapter = new ClaudeAdapter(sdk);

    expect(await adapter.listSessions('/tmp/p')).toEqual([
      { real_session_id: 's1', summary: 'Fix auth', cwd: '/tmp/p', modify_time: 100 },
      { real_session_id: 's2', summary: 'do the thing', cwd: '/tmp/p', modify_time: 200 },
    ]);
  });

  it('reads message history from the native transcript as text', async () => {
    const { sdk, setTranscript } = makeSdk();
    setTranscript([
      { type: 'user', uuid: 'u1', session_id: 's1', message: { content: 'hello' }, parent_tool_use_id: null, parent_agent_id: null },
      {
        type: 'assistant',
        uuid: 'u2',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'hi there' }, { type: 'thinking', thinking: 'x' }] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      { type: 'system', uuid: 'u3', session_id: 's1', message: {}, parent_tool_use_id: null, parent_agent_id: null },
    ]);
    const adapter = new ClaudeAdapter(sdk);

    const messages: Message[] = await adapter.getMessages('s1', '/tmp/p');
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });
});
