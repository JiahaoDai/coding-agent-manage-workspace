import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from '@opencode-ai/sdk';
import type { PromptHandlers } from '../../shared/adapter';
import type { Message, NativeSession } from '../../shared/session';
import { BaseAdapter } from './base';

/**
 * The slice of the OpenCode server API the adapter depends on, kept behind an
 * injectable seam so tests can drive a scripted session without spawning a real
 * `opencode serve` process (per the spec's testing decision: tests never spawn
 * a real agent). This is the raw client surface; the `OpenCodeAdapter` maps it
 * to the shared `AgentAdapter` contract (including native → app types).
 *
 * The event/part/permission shapes here are typed to what the real OpenCode
 * server emits (verified against a live `opencode serve` OpenAPI spec), not to
 * the `@opencode-ai/sdk` generated types — those lag the server on the
 * streaming and permission event names (see the note on `OpencodeEvent`).
 */
export interface OpencodeSdk {
  /** Subscribe to the server's SSE event stream, scoped to `cwd`. */
  subscribe(cwd: string): Promise<AsyncIterable<OpencodeEvent>>;

  /** Create a native session in `cwd`. Returns the agent's session id. */
  createSession(cwd: string, opts?: { name?: string }): Promise<{ id: string }>;

  /** List native sessions the server has in `cwd`. */
  listSessions(cwd: string): Promise<OpencodeNativeSession[]>;

  /** Read a session's transcript (messages + parts) from the native store. */
  getMessages(real_session_id: string, cwd: string): Promise<OpencodeTranscriptEntry[]>;

  /** Send a message; resolves with the completed reply once the turn finishes. */
  prompt(
    real_session_id: string,
    cwd: string,
    input: string,
  ): Promise<{ info: OpencodeAssistantMessage; parts: OpencodePart[] }>;

  /** Reply to a pending permission request. `once`/`always` allow, `reject` denies. */
  replyPermission(
    sessionID: string,
    permissionID: string,
    response: 'once' | 'always' | 'reject',
  ): Promise<void>;
}

/** A native session as the server lists it (the subset the adapter reads). */
export interface OpencodeNativeSession {
  id: string;
  title: string;
  directory?: string;
  time?: { updated?: number };
}

/** One transcript entry: a message plus the parts that render it. */
export interface OpencodeTranscriptEntry {
  info: { role: 'user' | 'assistant' };
  parts: OpencodePart[];
}

/**
 * Event shapes as the real `opencode serve` emits them (CLI 1.17.x). Two
 * deliberate departures from the SDK's generated types:
 *   - Text/thinking stream as a separate `message.part.delta` event
 *     ({ sessionID, messageID, partID, field, delta }); `message.part.updated`
 *     is a snapshot ({ sessionID, part, time }) used for tool-state transitions.
 *   - Permissions surface as `permission.asked` (v1) / `permission.v2.asked`
 *     (v2), not the SDK's `permission.updated`.
 */
export type OpencodeEvent =
  | {
      type: 'message.part.delta';
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    }
  | { type: 'message.part.updated'; properties: { sessionID: string; part: OpencodePart } }
  | { type: 'permission.asked'; properties: OpencodePermission }
  | { type: 'permission.v2.asked'; properties: OpencodePermissionV2 }
  | { type: 'session.idle'; properties: { sessionID: string } }
  | { type: 'session.status'; properties: { sessionID: string; status: { type: string } } }
  | { type: 'session.error'; properties: { sessionID?: string; error?: OpencodeError } };

/** A pending v1 permission request (a tool wants to run an action). */
export interface OpencodePermission {
  id: string;
  sessionID: string;
  /** The action being gated: bash, edit, webfetch, question, ... */
  permission: string;
  patterns: string[];
  /** Tool arguments — e.g. the shell command for a bash permission. */
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

/** A pending v2 permission request (action + resources). */
export interface OpencodePermissionV2 {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save: string[];
  metadata: Record<string, unknown>;
  source: { type: 'tool'; messageID: string; callID: string };
}

export interface OpencodeError {
  name?: string;
  data?: { message?: string };
}

/** The reply produced by a completed `prompt`. */
export interface OpencodeAssistantMessage {
  id: string;
  sessionID: string;
  role: 'assistant';
}

/** The parts of a message we care about; other kinds (snapshot, step, ...) are ignored. */
export type OpencodePart =
  | { type: 'text'; text: string; synthetic?: boolean; ignored?: boolean }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; callID: string; tool: string; state: OpencodeToolState };

export type OpencodeToolState =
  | { status: 'pending' | 'running'; input: Record<string, unknown> }
  | { status: 'completed' | 'error'; input: Record<string, unknown>; output?: string };

/** Mutable state a single turn's event mapping accumulates. */
export interface OpencodeEventState {
  /** Tool part ids already surfaced as started, so each tool streams exactly one start. */
  startedToolParts: Set<string>;
}

/**
 * The real client, bound once at module load. Lazily ensures an OpenCode server
 * is reachable on first use: an explicitly managed server via `OPENCODE_URL`,
 * or a headless `opencode serve` spawned by `createOpencodeServer`.
 */
export function createOpencodeSdk(): OpencodeSdk {
  let client: OpencodeClient | undefined;
  let server: { url: string; close(): void } | undefined;

  async function ensureClient(): Promise<OpencodeClient> {
    if (client) return client;
    const url = process.env.OPENCODE_URL;
    if (url) {
      client = createOpencodeClient({ baseUrl: url, throwOnError: true });
    } else {
      server = await createOpencodeServer();
      client = createOpencodeClient({ baseUrl: server.url, throwOnError: true });
    }
    return client;
  }

  return {
    async subscribe(cwd) {
      const c = await ensureClient();
      const result = await c.event.subscribe({ query: { directory: cwd } });
      return result.stream as unknown as AsyncIterable<OpencodeEvent>;
    },

    async createSession(cwd, opts) {
      const c = await ensureClient();
      const { data } = await c.session.create({
        throwOnError: true,
        query: { directory: cwd },
        body: { title: opts?.name },
      });
      return { id: data.id };
    },

    async listSessions(cwd) {
      const c = await ensureClient();
      const { data } = await c.session.list({ throwOnError: true, query: { directory: cwd } });
      return data as unknown as OpencodeNativeSession[];
    },

    async getMessages(real_session_id, cwd) {
      const c = await ensureClient();
      const { data } = await c.session.messages({
        throwOnError: true,
        path: { id: real_session_id },
        query: { directory: cwd },
      });
      return data as unknown as OpencodeTranscriptEntry[];
    },

    async prompt(real_session_id, cwd, input) {
      const c = await ensureClient();
      const { data } = await c.session.prompt({
        throwOnError: true,
        path: { id: real_session_id },
        query: { directory: cwd },
        body: { parts: [{ type: 'text' as const, text: input }] },
      });
      return data as unknown as { info: OpencodeAssistantMessage; parts: OpencodePart[] };
    },

    async replyPermission(sessionID, permissionID, response) {
      const c = await ensureClient();
      await c.postSessionIdPermissionsPermissionId({
        throwOnError: true,
        path: { id: sessionID, permissionID },
        body: { response },
      });
    },
  };
}

/**
 * Drives a real OpenCode session through the `AgentAdapter` contract.
 *
 * OpenCode has no separate "resume" call — a native session keeps its message
 * history, so continuing one is simply sending another prompt to the same id
 * (the design doc's "re-prompt" resume). `createSession` creates the native
 * session up front; `openSession` needs nothing beyond the record already
 * existing (the app validates that before calling it).
 *
 * Each turn subscribes to the server's SSE stream, sends the prompt (which
 * blocks until the reply completes), and folds the two together: the prompt's
 * resolution is the turn's end, `session.idle` confirms the final part
 * snapshots have flushed, and the stream supplies the streaming deltas, tool
 * state transitions, and permission requests that come back to the user.
 */
export class OpenCodeAdapter extends BaseAdapter {
  constructor(
    private readonly sdk: OpencodeSdk = createOpencodeSdk(),
    private readonly quiescenceMs = 5000,
  ) {
    super();
  }

  async createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }> {
    const { id } = await this.sdk.createSession(cwd, opts);
    return { real_session_id: id };
  }

  async listSessions(cwd: string): Promise<NativeSession[]> {
    const sessions = await this.sdk.listSessions(cwd);
    return sessions.map((s) => ({
      real_session_id: s.id,
      summary: s.title,
      cwd: s.directory ?? cwd,
      modify_time: s.time?.updated,
    }));
  }

  async getMessages(real_session_id: string, cwd: string): Promise<Message[]> {
    const entries = await this.sdk.getMessages(real_session_id, cwd);
    const out: Message[] = [];
    for (const entry of entries) {
      const content = transcriptText(entry.parts);
      if (content === null) continue;
      out.push({ role: entry.info.role, content });
    }
    return out;
  }

  async prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    const events = await this.sdk.subscribe(cwd);
    const state: OpencodeEventState = { startedToolParts: new Set() };

    // `settled` resolves when the turn is done (session.idle, or the stream
    // ending) and rejects when the consumer crashes (e.g. session.error) — so
    // a failure always surfaces as a failed turn rather than an unhandled
    // rejection. A short quiescence race guards against a server that never
    // emits idle; the timer is cleared when the turn ends.
    let signalIdle: () => void = () => {};
    let failTurn: (err: unknown) => void = () => {};
    const turnDone = new Promise<void>((resolve, reject) => {
      signalIdle = resolve;
      failTurn = reject;
    });
    let quiescenceTimer: ReturnType<typeof setTimeout> | undefined;
    const quiescence = new Promise<void>((resolve) => {
      quiescenceTimer = setTimeout(resolve, this.quiescenceMs);
    });
    const settled = Promise.race([turnDone, quiescence]);

    void (async () => {
      try {
        for await (const event of events) {
          if (event.type === 'session.error' && (event.properties.sessionID ?? '') === real_session_id) {
            throw new Error(opencodeErrorDetail(event.properties.error));
          }
          if (event.type === 'session.idle' && event.properties.sessionID === real_session_id) {
            signalIdle();
            continue;
          }
          if (
            event.type === 'session.status' &&
            event.properties.sessionID === real_session_id &&
            event.properties.status.type === 'idle'
          ) {
            signalIdle();
            continue;
          }
          if (event.type === 'permission.asked' && event.properties.sessionID === real_session_id) {
            await this.answerPermission(event.properties, handlers);
            continue;
          }
          if (event.type === 'permission.v2.asked' && event.properties.sessionID === real_session_id) {
            await this.answerPermissionV2(event.properties, handlers);
            continue;
          }
          mapOpencodeEvent(event, real_session_id, handlers, state);
        }
      } catch (err) {
        failTurn(err instanceof Error ? err : new Error(String(err)));
      } finally {
        // The stream ended (e.g. server restart): no more events will come, so
        // don't hold the turn open waiting for an idle event.
        signalIdle();
      }
    })();

    const reply = this.sdk.prompt(real_session_id, cwd, input);
    try {
      await Promise.all([reply, settled]);
    } finally {
      clearTimeout(quiescenceTimer);
      // Release the SSE subscription now that the turn is over (resolve or
      // error) so the connection doesn't outlive the prompt it served. A
      // failure here must not mask the turn's real outcome.
      const generator = events as AsyncGenerator<OpencodeEvent>;
      if (typeof generator.return === 'function') {
        try {
          await generator.return(undefined);
        } catch {
          // Ignored: the subscription is best-effort cleanup.
        }
      }
    }
    handlers.onStatusChange('completed');
  }

  private async answerPermission(
    permission: OpencodePermission,
    handlers: PromptHandlers,
  ): Promise<void> {
    // Round the request through the user, then answer the server. The
    // approve/deny shape is verified against a live server: "once" allows the
    // single action, "reject" denies it (the design never auto-allows beyond
    // the one action, so "always" is never chosen).
    const decision = await handlers.onPermissionRequest(permission.id, permission.permission, permission.metadata);
    await this.sdk.replyPermission(permission.sessionID, permission.id, decision === 'allow' ? 'once' : 'reject');
  }

  private async answerPermissionV2(
    permission: OpencodePermissionV2,
    handlers: PromptHandlers,
  ): Promise<void> {
    const decision = await handlers.onPermissionRequest(
      permission.id,
      permission.action,
      { ...permission.metadata, resources: permission.resources },
    );
    await this.sdk.replyPermission(permission.sessionID, permission.id, decision === 'allow' ? 'once' : 'reject');
  }
}

/**
 * Fold one stream event into the shared `PromptHandlers` contract. Pure — no
 * I/O — so it is the unit under test for the SDK → handler mapping.
 *
 * `message.part.delta` is the incremental token stream (the real server's event
 * for text/thinking); `message.part.updated` is the tool-state snapshot, so the
 * tool call start/end are emitted from a part's state transitions. Events for
 * other sessions or of other kinds are ignored.
 */
export function mapOpencodeEvent(
  event: OpencodeEvent,
  sessionID: string,
  handlers: PromptHandlers,
  state: OpencodeEventState,
): void {
  switch (event.type) {
    case 'message.part.delta': {
      if (event.properties.sessionID !== sessionID) return;
      const { field, delta } = event.properties;
      if (field === 'text') handlers.onTextDelta(delta);
      else if (field === 'reasoning') handlers.onThinkingDelta(delta);
      return;
    }

    case 'message.part.updated': {
      if (event.properties.sessionID !== sessionID) return;
      const part = event.properties.part;
      if (part.type !== 'tool') return;
      if (part.state.status === 'pending' || part.state.status === 'running') {
        if (!state.startedToolParts.has(part.id)) {
          state.startedToolParts.add(part.id);
          handlers.onToolCallStart(part.callID, part.tool, part.state.input ?? {});
        }
      } else if (part.state.status === 'completed' || part.state.status === 'error') {
        handlers.onToolCallEnd(part.callID);
      }
      return;
    }

    default:
      return;
  }
}

/** Human-readable detail from a `session.error` event. */
export function opencodeErrorDetail(error?: OpencodeError): string {
  if (!error) return 'OpenCode turn ended with an error';
  const message = error.data?.message;
  return message
    ? `${error.name ?? 'OpenCode error'}: ${message}`
    : (error.name ?? 'OpenCode turn ended with an error');
}

/**
 * Extract the displayable text of a transcript entry read from the native
 * store. Only non-synthetic text parts are kept (reasoning stays collapsed;
 * tool calls are shown live, not replayed as text). Returns null for entries
 * with no displayable text.
 */
function transcriptText(parts: OpencodePart[]): string | null {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && !part.synthetic && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.length ? texts.join('') : null;
}
