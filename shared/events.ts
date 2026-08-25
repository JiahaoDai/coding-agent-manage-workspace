import type { ShellCommandResult } from './adapter';
import type { SessionRecord, SessionStatus } from './session';
import type {
  TeamDeliveryStatus,
  TeamDeliveryDependencyRecord,
  TeamMessageDeliveryRecord,
  TeamMessageRecord,
  TeamRunRecord,
} from './team';

export interface TeamPermissionContext {
  team_id: string;
  team_name: string;
  run_id: string;
  member_id: string;
  member_role: string;
  member_agent: string;
  delivery_id: string;
  session_id: string;
  cwd: string;
}

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
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; input: unknown; team_context?: TeamPermissionContext }
  | { type: 'permission_response'; session_id: string; request_id: string; decision: 'allow' | 'deny'; team_context?: TeamPermissionContext }
  | { type: 'shell_result'; session_id: string; result: ShellCommandResult }
  | { type: 'session_removed'; session_id: string }
  | {
      type: 'team_run_created';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      user_message: TeamMessageRecord;
      delivery: TeamMessageDeliveryRecord;
    }
  | {
      type: 'team_delivery_status_change';
      session_id?: undefined;
      team_id: string;
      run_id: string;
      delivery_id: string;
      member_id: string;
      status: TeamDeliveryStatus;
    }
  | {
      type: 'team_text_delta';
      session_id?: undefined;
      team_id: string;
      run_id: string;
      delivery_id: string;
      member_id: string;
      text: string;
    }
  | {
      type: 'team_run_completed';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      final_message: TeamMessageRecord;
    }
  | {
      type: 'team_run_waiting_user';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      question_message: TeamMessageRecord;
      delivery: TeamMessageDeliveryRecord;
    }
  | {
      type: 'team_run_resumed';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      user_message: TeamMessageRecord;
      delivery: TeamMessageDeliveryRecord;
    }
  | {
      type: 'team_plan_created';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      plan_message: TeamMessageRecord;
      assignment_messages: TeamMessageRecord[];
      deliveries: TeamMessageDeliveryRecord[];
      dependencies: TeamDeliveryDependencyRecord[];
    }
  | {
      type: 'team_message_created';
      session_id?: undefined;
      team_id: string;
      message: TeamMessageRecord;
      delivery: TeamMessageDeliveryRecord | null;
    }
  | {
      type: 'team_run_failed';
      session_id?: undefined;
      team_id: string;
      run: TeamRunRecord;
      error_message: TeamMessageRecord;
    }
  | { type: 'error'; session_id: string; message: string };
