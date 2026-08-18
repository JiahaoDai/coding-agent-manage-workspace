import type { Message, NativeSession, SessionStatus } from './session';

/**
 * The single seam between the server and any coding agent. Every agent is
 * wrapped by one implementation of this interface; the server never talks to
 * an agent SDK directly. Tests inject a fake implementation and assert only on
 * the server's externally observable behaviour.
 *
 * Method signatures are the contract's first deliverable and are agreed here
 * before any real agent adapter is written.
 */
export interface AgentAdapter {
  /** Create a fresh native session in `cwd`. Returns the agent's native session id. */
  createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }>;

  /** Open/resume an existing native session. */
  openSession(real_session_id: string, cwd: string): Promise<{ real_session_id: string }>;

  /** List native sessions the agent already has in `cwd` (for create-time resume). */
  listSessions(cwd: string): Promise<NativeSession[]>;

  /** Read a session's messages from the agent's native store. */
  getMessages(real_session_id: string, cwd: string): Promise<Message[]>;

  /**
   * Send a message and stream the reply through `handlers`. Resolves when the
   * turn finishes (or rejects on error).
   */
  prompt(real_session_id: string, cwd: string, input: string, handlers: PromptHandlers): Promise<void>;
}

/** Callbacks an adapter drives while streaming a prompt. */
export interface PromptHandlers {
  onTextDelta(text: string): void;
  onToolCallStart(tool_call_id: string, name: string, input: unknown): void;
  onToolCallEnd(tool_call_id: string): void;
  onThinkingDelta(text: string): void;
  onStatusChange(status: SessionStatus): void;
  /** Interactive permission confirmation. Resolve with the user's decision. */
  onPermissionRequest(request_id: string, tool_name: string, input: unknown): Promise<'allow' | 'deny'>;
}
