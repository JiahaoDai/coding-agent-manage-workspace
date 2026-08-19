import type { SessionRecord, SessionStatus } from './session';

/**
 * Events streamed downstream (server → client) over the single multiplexed SSE
 * stream. Every event carries a `session_id` (except a session-less `error`)
 * so the client can route it to the correct window.
 */
export type ServerEvent =
  | { type: 'session_created'; session_id: string; session: SessionRecord }
  | { type: 'text_delta'; session_id: string; text: string }
  | { type: 'tool_call_start'; session_id: string; tool_call_id: string; name: string; input: unknown }
  | { type: 'tool_call_end'; session_id: string; tool_call_id: string }
  | { type: 'thinking_delta'; session_id: string; text: string }
  | { type: 'status_note'; session_id: string; text: string }
  | { type: 'status_change'; session_id: string; status: SessionStatus }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; input: unknown }
  | { type: 'permission_response'; session_id: string; request_id: string; decision: 'allow' | 'deny' }
  | { type: 'session_removed'; session_id: string }
  | { type: 'error'; session_id: string; message: string };
