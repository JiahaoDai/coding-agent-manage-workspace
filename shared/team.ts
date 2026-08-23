import type { AgentId } from './session';

export type TeamStatus = 'idle' | 'running' | 'error' | 'archived';
export type TeamMemberStatus = 'idle' | 'running' | 'waiting_permission' | 'error';

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
