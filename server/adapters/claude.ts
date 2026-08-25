import { randomUUID } from 'node:crypto';
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type Options,
  type SDKSessionInfo,
  type SDKMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { CapabilityResult, ModelOption, PromptHandlers } from '../../shared/adapter';
import type { Message, NativeSession } from '../../shared/session';
import { BaseAdapter } from './base';

/**
 * The slice of the Claude Agent SDK the adapter depends on, kept behind an
 * injectable seam so tests can drive a scripted agent without spawning a real
 * Claude Code session (per the spec's testing decision: tests never spawn a
 * real agent).
 */
export interface ClaudeSdk {
  query(params: { prompt: string | AsyncIterable<never>; options?: Options }): AsyncIterable<SDKMessage> & {
    supportedModels?: () => Promise<Array<{ value: string; displayName: string }>>;
    close?: () => void;
  };
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
  listSessions(options?: { dir?: string }): Promise<SDKSessionInfo[]>;
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<SessionMessage[]>;
}

/** The real SDK, bound once at module load. */
const realSdk: ClaudeSdk = { query, getSessionInfo, listSessions, getSessionMessages };

/**
 * Drives a real Claude Code session through the `AgentAdapter` contract.
 *
 * Claude Code has no "create an empty session" API — a native session comes
 * into being on its first `query()`. So `createSession` pre-generates a UUID and
 * `prompt` passes it as `sessionId` on the first turn (creating the native
 * session under that exact id) and as `resume` on every later turn. Whether a
 * session is fresh or already exists is decided by asking the SDK whether the
 * id resolves, which keeps the adapter stateless across a server restart.
 */
export class ClaudeAdapter extends BaseAdapter {
  private readonly selectedModels = new Map<string, string | null>();
  constructor(private readonly sdk: ClaudeSdk = realSdk) {
    super();
  }

  async createSession(_cwd: string, _opts?: { name?: string }): Promise<{ real_session_id: string }> {
    return { real_session_id: randomUUID() };
  }

  async listSessions(cwd: string): Promise<NativeSession[]> {
    const sessions = await this.sdk.listSessions({ dir: cwd });
    return sessions.map((s) => ({
      real_session_id: s.sessionId,
      summary: s.summary || s.firstPrompt,
      cwd: s.cwd ?? cwd,
      modify_time: s.lastModified,
    }));
  }

  async getMessages(real_session_id: string, cwd: string): Promise<Message[]> {
    const messages = await this.sdk.getSessionMessages(real_session_id, { dir: cwd });
    const out: Message[] = [];
    for (const m of messages) {
      const content = sessionMessageText(m);
      if (content === null) continue;
      out.push({ role: m.type === 'assistant' ? 'assistant' : 'user', content });
    }
    return out;
  }

  async listModels(cwd: string): Promise<CapabilityResult<ModelOption[]>> {
    // Claude exposes available models from its initialized streaming Query. An
    // empty input stream initializes controls without adding a user turn.
    const control = this.sdk.query({ prompt: emptyInput(), options: { cwd, permissionMode: 'default' } });
    if (!control.supportedModels) return { supported: false, reason: 'Claude model discovery is unavailable in this SDK.' };
    try {
      return { supported: true, value: (await control.supportedModels()).map((model) => ({ id: model.value, label: model.displayName, provider: 'Claude' })) };
    } finally {
      control.close?.();
    }
  }

  async setModel(real_session_id: string, cwd: string, model_id: string | null): Promise<CapabilityResult<void>> {
    if (model_id !== null) {
      const models = await this.listModels(cwd);
      if (!models.supported) return models;
      if (!models.value.some((model) => model.id === model_id)) throw new Error(`Model is not available: ${model_id}`);
    }
    this.selectedModels.set(real_session_id, model_id);
    return { supported: true, value: undefined };
  }

  async prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    const options: Options = {
      cwd,
      model: this.selectedModels.get(real_session_id) ?? undefined,
      // Design §9: always 'default', never bypass/accept-edits, so every
      // unapproved tool surfaces through canUseTool instead of silently running.
      permissionMode: 'default',
      // Token-level text + thinking deltas (ticket #2's incremental streaming).
      includePartialMessages: true,
      canUseTool: async (toolName, toolInput, ctx) => {
        // Every unapproved tool (including AskUserQuestion clarifications)
        // round-trips through the user via the shared permission broker. The
        // tool_use id is unique within the session, which is exactly the scope
        // the broker keys by.
        const decision = await handlers.onPermissionRequest(ctx.toolUseID, toolName, toolInput);
        return decision === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Denied by user' };
      },
    };

    // First turn of a fresh session: the native session doesn't exist yet, so
    // create it under our pre-generated id. Every other case (resumed at create
    // time, or a later turn) continues the existing session.
    let existing: SDKSessionInfo | undefined;
    try {
      existing = await this.sdk.getSessionInfo(real_session_id, { dir: cwd });
    } catch {
      // Treat an unreadable store as "not created yet"; the query itself will
      // surface any real failure.
      existing = undefined;
    }
    if (existing) {
      options.resume = real_session_id;
    } else {
      options.sessionId = real_session_id;
    }

    for await (const message of this.sdk.query({ prompt: input, options })) {
      mapClaudeMessage(message, handlers);
    }
  }
}

async function* emptyInput(): AsyncIterable<never> {
  // The stream intentionally has no user message.
}

/**
 * Fold one SDK message into the shared `PromptHandlers` contract. Pure — no I/O
 * — so it is the unit under test for the SDK → handler mapping.
 *
 * Streaming shape (with `includePartialMessages`): text and thinking arrive as
 * `stream_event` deltas, then the complete `assistant` message repeats them but
 * also carries the full tool_use input. We stream the deltas and take only the
 * tool_use blocks from the complete message, so text/thinking aren't doubled
 * and tool calls render with their real arguments.
 */
export function mapClaudeMessage(message: SDKMessage, handlers: PromptHandlers): void {
  switch (message.type) {
    case 'stream_event': {
      const event = message.event;
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') handlers.onTextDelta(event.delta.text);
        else if (event.delta.type === 'thinking_delta') handlers.onThinkingDelta(event.delta.thinking);
      }
      return;
    }

    case 'assistant': {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          handlers.onToolCallStart(block.id, block.name, block.input);
          handlers.onToolCallEnd(block.id);
        }
      }
      return;
    }

    case 'result': {
      if (message.subtype === 'success' && !message.is_error) {
        handlers.onStatusChange('completed');
        return;
      }
      const detail =
        message.subtype === 'success'
          ? message.result || 'Claude turn ended with an error'
          : message.errors.join('; ') || `Claude turn ended with ${message.subtype}`;
      throw new Error(detail);
    }

    default:
      // system (init/status), user (tool results), and other informational
      // messages carry nothing to render in the conversation.
      return;
  }
}

/**
 * Extract the displayable text of a transcript message read from the native
 * store. Only `text` blocks are kept (thinking stays collapsed; tool calls are
 * shown live, not replayed as text). Returns null for messages with no text.
 */
function sessionMessageText(m: SessionMessage): string | null {
  if (m.type === 'system') return null;
  const content = (m.message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as { type?: string; text?: string };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length ? parts.join('') : null;
}
