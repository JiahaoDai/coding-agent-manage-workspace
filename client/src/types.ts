// Re-export the shared contract so client components import from one place.
export type {
  AgentId,
  ReimportableSession,
  SessionRecord,
  SessionStatus,
} from '../../shared/session';
export type { ServerEvent } from '../../shared/events';

/** A permission request awaiting the user's decision, derived from the SSE event. */
export interface PermissionRequest {
  session_id: string;
  request_id: string;
  tool_name: string;
  input: unknown;
}
