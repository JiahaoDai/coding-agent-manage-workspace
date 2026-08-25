import type { SessionStatus } from './types';

/** Human-readable label for each session status, shared by list and conversation. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  error: 'Error',
  cancelled: 'Cancelled',
};
