import type { AgentId } from './session';

export type TeamStatus = 'idle' | 'running' | 'error' | 'archived';
export type TeamMemberStatus = 'idle' | 'running' | 'waiting_permission' | 'error';
export type TeamRunStatus = 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
export type TeamMessageKind =
  | 'user_request'
  | 'assignment'
  | 'result'
  | 'review'
  | 'need_info'
  | 'proposal'
  | 'final'
  | 'status'
  | 'error';
export type TeamMessageFromKind = 'user' | 'member' | 'system';
export type TeamDeliveryStatus = 'blocked' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type TeamDeliveryDependencyType = 'success' | 'finished';

export interface TeamRecord {
  team_id: string;
  name: string;
  cwd: string;
  status: TeamStatus;
  max_parallel_members: number;
  create_time: number;
  modify_time: number;
}

export interface TeamMemberRecord {
  member_id: string;
  team_id: string;
  role: string;
  coding_agent: AgentId;
  session_id: string;
  model: string | null;
  responsibility_prompt: string;
  status: TeamMemberStatus;
  current_delivery_id: string | null;
  create_time: number;
  modify_time: number;
}

export interface TeamWithMembers extends TeamRecord {
  members: TeamMemberRecord[];
}

export interface TeamRunRecord {
  run_id: string;
  team_id: string;
  root_user_message_id: string;
  status: TeamRunStatus;
  max_rounds: number;
  current_round: number;
  create_time: number;
  finish_time: number | null;
}

export interface TeamMessageRecord {
  message_id: string;
  team_id: string;
  run_id: string;
  from_member_id: string | null;
  from_kind: TeamMessageFromKind;
  kind: TeamMessageKind;
  content: string;
  create_time: number;
}

export interface TeamMessageDeliveryRecord {
  delivery_id: string;
  message_id: string;
  team_id: string;
  run_id: string;
  to_member_id: string;
  status: TeamDeliveryStatus;
  enqueue_seq: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export interface TeamDeliveryDependencyRecord {
  delivery_id: string;
  depends_on_delivery_id: string;
  dependency_type: TeamDeliveryDependencyType;
}

export interface TeamRunWithItems {
  run: TeamRunRecord;
  messages: TeamMessageRecord[];
  deliveries: TeamMessageDeliveryRecord[];
  dependencies: TeamDeliveryDependencyRecord[];
}

export interface TeamMemberInput {
  role: string;
  agent: AgentId;
  model: string | null;
  responsibility_prompt: string;
}

export interface CreateTeamInput {
  name: string;
  cwd: string;
  members: TeamMemberInput[];
}
