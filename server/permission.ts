import type { TeamPermissionContext } from '../shared/events';

/**
 * Tracks permission requests that are waiting on the user and resolves the
 * promise the adapter is awaiting when a client posts a decision.
 *
 * One broker per app instance (created inside `createApp`), so tests and any
 * future tenants don't share pending state.
 */
export class PermissionBroker {
  /**
   * Keyed by `${session_id}:${request_id}`. A request id is only guaranteed
   * unique within a session (real agents often reuse per-turn counters), so
   * scoping by the composite key is what keeps two concurrent sessions with
   * colliding ids from resolving each other's promises.
   */
  private readonly pending = new Map<
    string,
    { session_id: string; context?: TeamPermissionContext; resolve: (decision: 'allow' | 'deny') => void }
  >();

  private static key(session_id: string, request_id: string): string {
    return `${session_id}:${request_id}`;
  }

  /**
   * Register a request and return the promise the adapter awaits. The promise
   * resolves when the user answers and never rejects; if nobody ever answers,
   * the turn simply stays `running` (cancellation is a later ticket).
   */
  request(session_id: string, request_id: string, context?: TeamPermissionContext): Promise<'allow' | 'deny'> {
    return new Promise((resolve) => {
      this.pending.set(PermissionBroker.key(session_id, request_id), { session_id, context, resolve });
    });
  }

  /**
   * Resolve a request. Only succeeds when a request with this id is pending
   * for THIS session — a permission answer is always scoped to the session
   * that asked, so a stale or cross-session answer is rejected. Returns false
   * when there is nothing to resolve.
   */
  resolve(session_id: string, request_id: string, decision: 'allow' | 'deny'): { context?: TeamPermissionContext } | null {
    const entry = this.pending.get(PermissionBroker.key(session_id, request_id));
    if (!entry) return null;
    this.pending.delete(PermissionBroker.key(session_id, request_id));
    entry.resolve(decision);
    return { context: entry.context };
  }

  /** Number of outstanding requests — used to assert broker state in tests. */
  get size(): number {
    return this.pending.size;
  }
}
