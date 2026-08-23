// Re-export the shared contract so client components import from one place.
export type { FsEntry } from '../../shared/fs';
export type {
  AgentId,
  Message,
  ResumableSession,
  SessionRecord,
  SessionStatus,
} from '../../shared/session';
export type { ServerEvent } from '../../shared/events';
export type { CapabilityResult, ModelOption } from '../../shared/adapter';
export type {
  CreateTeamInput,
  TeamMemberInput,
  TeamMemberRecord,
  TeamMessageDeliveryRecord,
  TeamMessageRecord,
  TeamRecord,
  TeamRunRecord,
  TeamRunWithItems,
  TeamWithMembers,
} from '../../shared/team';

/** A permission request awaiting the user's decision, derived from the SSE event. */
export interface PermissionRequest {
  session_id: string;
  request_id: string;
  tool_name: string;
  input: unknown;
}
