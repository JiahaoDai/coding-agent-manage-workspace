// Types shared between client and server. Type-only — no runtime values.
//
// This file (and the rest of `shared/`) is the contract both sides compile
// against. It is deliberately free of runtime code so the server and the
// client each type-check against the same definitions without a build step.

/**
 * Identifier for a coding agent. An open set by design: adding a new agent
 * means writing a new adapter, not widening a union here.
 */
export type AgentId = string;

/** Lifecycle state of a session, as shown in the UI. `completed` also means "idle, ready for the next message". */
export type SessionStatus = 'running' | 'completed' | 'error' | 'cancelled';

/**
 * A session as stored in the app's own SQLite metadata table. This is the
 * interface's record of a session — message bodies are never stored here.
 */
export interface SessionRecord {
  /** The app's own session id (UUID). */
  session_id: string;
  /** Which agent this session belongs to. */
  coding_agent: AgentId;
  /** The agent's native session id, used to read message bodies from the native store. */
  real_session_id: string;
  /** Display name the user chose at creation. */
  name: string;
  /** Absolute path to the project directory the session runs in. */
  cwd: string;
  status: SessionStatus;
  /** Agent-native model selected for the next turn, or null for the agent default. */
  model: string | null;
  /** Most recent adapter or SDK failure. Cleared after the next successful turn. */
  last_error: string | null;
  /** Epoch milliseconds. */
  create_time: number;
  /** Epoch milliseconds. */
  modify_time: number;
}

/** A session found in an agent's native store (used for create-time resume). */
export interface NativeSession {
  real_session_id: string;
  /** Native summary or first prompt, used to prefill a resume session's name. */
  summary?: string;
  cwd?: string;
  modify_time?: number;
}

/** A native session offered for resume at create time: it exists in the agent's
 * store but not in the app's own store (soft-deleted, or created outside the
 * app), so a fresh record can be created to continue it. */
export interface ResumableSession extends NativeSession {
  coding_agent: AgentId;
  cwd: string;
}

/** A message read from an agent's native store at display time. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
