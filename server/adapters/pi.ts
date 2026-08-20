import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type SessionEntry,
  type SessionInfo,
  type ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import type { PromptHandlers } from '../../shared/adapter';
import type { Message, NativeSession } from '../../shared/session';
import { BaseAdapter } from './base';

/**
 * The slice of the Pi SDK the adapter depends on, kept behind an injectable
 * seam so tests can drive a scripted session without a real Pi runtime (per the
 * spec's testing decision: tests never spawn a real agent).
 *
 * Unlike OpenCode (a client/server over SSE) Pi is an in-process SDK: the live
 * `AgentSession` is created by `createAgentSession` and held in a per-adapter
 * cache keyed by the native session file path. The seam exposes the pieces the
 * `PiAdapter` orchestrates and hides `createAgentSession` behind it.
 *
 * `real_session_id` is Pi's native session **file path** (a `.jsonl` under
 * `~/.pi/agent/sessions/<encoded-cwd>/`): `SessionManager.list` returns paths,
 * `SessionManager.open` opens a path, and a created session reports its file via
 * `session.sessionFile`.
 */
export interface PiSdk {
  /**
   * Create a fresh persistent Pi session in `cwd`. Returns the native session
   * file path (deterministic once created; Pi materializes the `.jsonl` on disk
   * on the first assistant message, so a brand-new session lists empty until
   * its first turn).
   */
  createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }>;

  /**
   * Open an existing native session (its file path) so its history continues.
   * Idempotent: returns the same live handle for a repeated id.
   */
  openSession(real_session_id: string, cwd: string): Promise<PiSessionHandle>;

  /** List native sessions Pi has stored for `cwd` (create-time resume candidates). */
  listSessions(cwd: string): Promise<PiNativeSession[]>;

  /** Read a session's transcript from its native file as user/assistant text. */
  getMessages(real_session_id: string, cwd: string): Promise<Message[]>;
}

/** A live Pi session, open for streaming. */
export interface PiSessionHandle {
  /** Send a prompt; resolves when the full run (including retries) finishes. */
  prompt(input: string): Promise<void>;

  /** True while a prompt is streaming on this session. */
  isStreaming(): boolean;

  /**
   * Route approval decisions from the session's permission gate back to the
   * app. The gate is an in-process extension (see `createPermissionGate`) that
   * blocks side-effectful tools until this resolver answers.
   */
  setPermissionResolver(resolver: PermissionResolver): void;

  /** Subscribe to the session's events. Returns an unsubscribe function. */
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
}

/** Resolves whether a gated tool call may run. `allow` lets it through, `deny` blocks it. */
export type PermissionResolver = (
  request_id: string,
  tool_name: string,
  input: unknown,
) => Promise<'allow' | 'deny'>;

/** A native session as Pi lists it (the subset the adapter reads). */
export interface PiNativeSession {
  /** Absolute path to the session's `.jsonl` file — the dashboard's real_session_id. */
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: Date;
}

/**
 * The Pi events the adapter maps, as a slim subset of the real `AgentSessionEvent`
 * union. The real SDK emits a broad union (message lifecycle, compaction, queue
 * updates, …); the adapter only cares about the streaming text/thinking deltas,
 * the tool execution lifecycle, and provider retries. `toPiAgentEvent` narrows
 * the real events to this shape at the seam, keeping the pure mapping function
 * and its fixtures small.
 */
export type PiAgentEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'message_update'; assistantMessageEvent: { type: 'thinking_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; errorMessage: string };

/**
 * Fold one Pi session event into the shared `PromptHandlers` contract. Pure —
 * no I/O — so it is the unit under test for the SDK → handler mapping.
 *
 * `message_update` is the incremental token stream (text or thinking deltas);
 * `tool_execution_start`/`tool_execution_end` are the tool call lifecycle;
 * `auto_retry_start` is a provider retry, surfaced as a status note so a turn
 * that isn't producing output still communicates why.
 */
export function mapPiEvent(event: PiAgentEvent, handlers: PromptHandlers): void {
  switch (event.type) {
    case 'message_update': {
      const sub = event.assistantMessageEvent;
      if (sub.type === 'text_delta') handlers.onTextDelta(sub.delta);
      else if (sub.type === 'thinking_delta') handlers.onThinkingDelta(sub.delta);
      return;
    }

    case 'tool_execution_start':
      handlers.onToolCallStart(event.toolCallId, event.toolName, event.args ?? {});
      return;

    case 'tool_execution_end':
      handlers.onToolCallEnd(event.toolCallId);
      return;

    case 'auto_retry_start':
      handlers.onStatusNote(
        `Pi retrying (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
      );
      return;
  }
}

/**
 * The real client, bound once. A per-adapter cache maps a native session file
 * path to its live `AgentSession` plus the mutable permission resolver the
 * session's gate extension reads, so opening a session twice reuses the live
 * session instead of creating a second runtime.
 *
 * Sessions are created in `~/.pi/agent/sessions/<encoded-cwd>/` (Pi's default
 * native store), which is what makes resume work: `listSessions` finds sessions
 * created earlier — by the app or by the `pi` CLI itself.
 *
 * `model` sets the session model (a Pi CLI model string like
 * `deepseek/deepseek-v4-flash`, or `provider/*:thinking`). Falls back to
 * `PI_MODEL`, then to Pi's own default resolution (settings → first available).
 */
export function createPiSdk(config: { model?: string } = {}): PiSdk {
  const modelSpec = config.model ?? process.env.PI_MODEL;
  const live = new Map<
    string,
    { session: AgentSession; permRef: { ask: PermissionResolver } }
  >();

  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  function modelRuntime(): Promise<ModelRuntime> {
    modelRuntimePromise ??= ModelRuntime.create();
    return modelRuntimePromise;
  }

  async function resolveModel() {
    if (!modelSpec) return undefined; // let Pi resolve its default model
    const runtime = await modelRuntime();
    const resolved = resolveCliModel({ cliModel: modelSpec, modelRuntime: runtime });
    if (resolved.error) throw new Error(`Pi model resolution failed: ${resolved.error}`);
    return resolved.model;
  }

  /** Create (or reopen) the live AgentSession from the given SessionManager. */
  async function createLive(
    cwd: string,
    sessionManager: SessionManager,
  ): Promise<{ session: AgentSession; permRef: { ask: PermissionResolver } }> {
    const [model, runtime] = await Promise.all([resolveModel(), modelRuntime()]);
    // The gate extension reads this ref at tool-call time; `prompt` swaps in the
    // turn's resolver right before running. The safe default denies: a gated
    // tool never auto-runs without an app answer.
    const permRef: { ask: PermissionResolver } = {
      ask: async () => 'deny',
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      extensionFactories: [createPermissionGate(permRef)],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager,
    });
    return { session, permRef };
  }

  return {
    async createSession(cwd, opts) {
      const sm = SessionManager.create(cwd);
      const { session, permRef } = await createLive(cwd, sm);
      const file = session.sessionFile;
      if (!file) throw new Error('Pi session file was not created');
      if (opts?.name) sm.appendSessionInfo(opts.name);
      live.set(file, { session, permRef });
      return { real_session_id: file };
    },

    async openSession(real_session_id, cwd) {
      const cached = live.get(real_session_id);
      if (cached) {
        return handleFor(cached);
      }
      // cwdOverride pins the session's cwd. Normally the file exists and its
      // header carries the real cwd; for a created-but-never-prompted session
      // (Pi writes the file on the first assistant message) the override keeps
      // the header honest instead of `SessionManager.open`'s process.cwd() fallback.
      const { session, permRef } = await createLive(cwd, SessionManager.open(real_session_id, undefined, cwd));
      live.set(real_session_id, { session, permRef });
      return handleFor({ session, permRef });
    },

    async listSessions(cwd) {
      const infos = await SessionManager.list(cwd);
      return infos.map(toNativeSession);
    },

    async getMessages(real_session_id, _cwd) {
      const sm = SessionManager.open(real_session_id);
      return transcriptMessages(sm.getEntries());
    },
  };

  function handleFor(entry: { session: AgentSession; permRef: { ask: PermissionResolver } }): PiSessionHandle {
    const { session, permRef } = entry;
    return {
      async prompt(input) {
        await session.prompt(input);
      },
      isStreaming: () => session.isStreaming,
      setPermissionResolver(resolver) {
        permRef.ask = resolver;
      },
      subscribe(listener) {
        return session.subscribe((event) => {
          const slim = toPiAgentEvent(event);
          if (slim) listener(slim);
        });
      },
    };
  }
}

/**
 * Pi has no native permission mode (no `canUseTool`, no `permission.asked`
 * event). Its approval seam is extensions: an inline extension listens to the
 * `tool_call` event — fired before a tool executes — and returns `undefined` to
 * allow or `{ block: true, reason }` to turn the call into an error result the
 * agent sees. The user's decision is reached through the resolver ref, which the
 * adapter points at `handlers.onPermissionRequest` for each turn.
 *
 * Tools that mutate state (`bash`, `write`, `edit`) are gated; read-only tools
 * (`read`, `grep`, `find`, `ls`) run without asking, mirroring Claude Code's
 * default permission set. This is the "wired" form of the design doc's per-agent
 * permission story (§9): every side-effectful action round-trips through the UI.
 */
function createPermissionGate(permRef: { ask: PermissionResolver }): InlineExtension {
  return {
    name: 'dashboard-permission-gate',
    factory: (pi) => {
      pi.on('tool_call', async (event: ToolCallEvent) => {
        if (!needsApproval(event.toolName)) return undefined;
        const decision = await permRef.ask(`pi-${event.toolCallId}`, event.toolName, event.input);
        return decision === 'allow' ? undefined : { block: true, reason: 'Denied by user' };
      });
    },
  };
}

const APPROVAL_TOOLS = new Set(['bash', 'write', 'edit']);

/** Whether a tool call may run without asking the user. */
function needsApproval(toolName: string): boolean {
  return APPROVAL_TOOLS.has(toolName);
}

/**
 * Drives a real Pi session through the `AgentAdapter` contract.
 *
 * Resume is native: a Pi session is a `.jsonl` file, so opening the same file
 * (`SessionManager.open`) continues its history. `createSession` creates a fresh
 * persistent session up front; `openSession` opens an existing native one.
 *
 * Each turn gets the live handle, points its permission resolver at the app's
 * handler, subscribes to the event stream, and awaits `prompt` — which resolves
 * when the full run finishes (including Pi's internal retries). Pi is in-process,
 * so unlike OpenCode there is no SSE connection to quiesce or tear down.
 */
export class PiAdapter extends BaseAdapter {
  constructor(private readonly sdk: PiSdk = createPiSdk()) {
    super();
  }

  async createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }> {
    return this.sdk.createSession(cwd, opts);
  }

  async openSession(real_session_id: string, cwd: string): Promise<{ real_session_id: string }> {
    // Actually open the native session so its live runtime is ready to continue
    // (resume). Idempotent in the sdk.
    await this.sdk.openSession(real_session_id, cwd);
    return { real_session_id };
  }

  async listSessions(cwd: string): Promise<NativeSession[]> {
    const sessions = await this.sdk.listSessions(cwd);
    return sessions.map((s) => ({
      real_session_id: s.path,
      summary: s.firstMessage || s.name || undefined,
      cwd: s.cwd || cwd,
      modify_time: s.modified.getTime(),
    }));
  }

  async getMessages(real_session_id: string, cwd: string): Promise<Message[]> {
    return this.sdk.getMessages(real_session_id, cwd);
  }

  async prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    const handle = await this.sdk.openSession(real_session_id, cwd);
    if (handle.isStreaming()) {
      // Pi refuses a second prompt while streaming (it would need a
      // streamingBehavior to queue); surface that as a clear error instead of
      // the SDK's terse one. The app marks the turn error and the UI can act.
      throw new Error(
        'Pi session is already busy — wait for the current turn to finish before sending another message.',
      );
    }

    const unsubscribe = handle.subscribe((event) => mapPiEvent(event, handlers));
    try {
      handle.setPermissionResolver((request_id, tool_name, input) =>
        handlers.onPermissionRequest(request_id, tool_name, input),
      );
      await handle.prompt(input);
      handlers.onStatusChange('completed');
    } finally {
      unsubscribe();
    }
  }
}

/** Narrow a real Pi session event to the slim shape the adapter maps. */
function toPiAgentEvent(event: AgentSessionEvent): PiAgentEvent | null {
  switch (event.type) {
    case 'message_update': {
      const sub = event.assistantMessageEvent;
      if (sub.type === 'text_delta') {
        return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: sub.delta } };
      }
      if (sub.type === 'thinking_delta') {
        return { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: sub.delta } };
      }
      return null;
    }
    case 'tool_execution_start':
      return {
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case 'auto_retry_start':
      return {
        type: 'auto_retry_start',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage,
      };
    default:
      return null;
  }
}

/** Map a Pi native session listing to the shape the adapter returns. */
function toNativeSession(info: SessionInfo): PiNativeSession {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    firstMessage: info.firstMessage,
    modified: info.modified,
  };
}

/** Extract displayable user/assistant text from a session's stored entries. */
export function transcriptMessages(entries: SessionEntry[]): Message[] {
  const out: Message[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (text === null) continue;
    out.push({ role: message.role, content: text });
  }
  return out;
}

/** Extract the text of a message. Returns null when the message has no text. */
function messageText(message: { role: string; content: unknown }): string | null {
  const content = message.content;
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text' as const, text: content }]
      : Array.isArray(content)
        ? content
        : [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      texts.push(String((block as { text?: unknown }).text ?? ''));
    }
  }
  return texts.length ? texts.join('') : null;
}
