import type { Message, NativeSession, SessionStatus } from './session';

/** A capability response deliberately distinguishes an unsupported SDK feature
 * from a supported feature that happens to have no current results. For
 * example, model discovery with no configured models is supported with `[]`,
 * while an adapter that cannot discover models returns `supported: false`. */
export type CapabilityResult<T> =
  | { supported: true; value: T }
  | { supported: false; reason: string };

/** A model the dashboard may display and submit back to the same adapter. */
export interface ModelOption {
  /** Stable, agent-native identifier used for selection. */
  id: string;
  /** Human-readable label for the model picker. */
  label: string;
  /** Optional provider/account grouping supplied by the adapter. */
  provider?: string;
}

/** An agent-native slash command available in the current session context. */
export interface NativeCommand {
  /** Canonical command text, including the leading slash. */
  name: string;
  /** Short explanation suitable for composer autocomplete. */
  description?: string;
}

/** The structured result of a direct user shell command. It is never an agent
 * prompt or an adapter failure merely because `exit_code` is non-zero. */
export interface ShellCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
}

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

  /** Discover models currently usable by this agent in the local environment. */
  listModels(cwd: string): Promise<CapabilityResult<ModelOption[]>>;

  /** Select a model for a native session before its next turn. */
  setModel(real_session_id: string, cwd: string, model_id: string | null): Promise<CapabilityResult<void>>;

  /** Discover agent-native slash commands in the current session context. */
  listNativeCommands(real_session_id: string, cwd: string): Promise<CapabilityResult<NativeCommand[]>>;

  /** Execute an agent-native slash command. Agent tool calls still stream and
   * use the normal permission handlers. */
  runNativeCommand(
    real_session_id: string,
    cwd: string,
    command: string,
    handlers: PromptHandlers,
  ): Promise<CapabilityResult<void>>;

  /** Execute an explicitly user-authorised shell command in the session cwd.
   * The result is rendered separately and must not be injected into agent context. */
  runShellCommand(
    real_session_id: string,
    cwd: string,
    command: string,
  ): Promise<CapabilityResult<ShellCommandResult>>;

  /** Release any adapter-owned background processes or connections. */
  close?(): void | Promise<void>;
}

/** Callbacks an adapter drives while streaming a prompt. */
export interface PromptHandlers {
  onTextDelta(text: string): void;
  onToolCallStart(tool_call_id: string, name: string, input: unknown): void;
  onToolCallEnd(tool_call_id: string): void;
  onThinkingDelta(text: string): void;
  /**
   * Transient progress note from the agent (e.g. OpenCode's rate-limit retry
   * status). Shown to the user as a system message so a turn that isn't
   * producing output still communicates why.
   */
  onStatusNote(text: string): void;
  onStatusChange(status: SessionStatus): void;
  /**
   * Interactive permission confirmation. Called when the agent wants to run a
   * tool that isn't auto-approved. Resolve with the user's decision; `deny` is
   * reported back to the agent so it can stop or adjust.
   *
   * Adapters MUST launch their agent with the equivalent of
   * `permissionMode: 'default'` (never bypass/accept-edits) so every such tool
   * surfaces here instead of silently running.
   */
  onPermissionRequest(request_id: string, tool_name: string, input: unknown): Promise<'allow' | 'deny'>;
}
