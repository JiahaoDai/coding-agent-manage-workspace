/**
 * Tracks permission requests that are waiting on the user and resolves the
 * promise the adapter is awaiting when a client posts a decision.
 *
 * One broker per app instance (created inside `createApp`), so tests and any
 * future tenants don't share pending state.
 */
export class PermissionBroker {
  private readonly pending = new Map<
    string,
    { session_id: string; resolve: (decision: 'allow' | 'deny') => void }
  >();

  /**
   * Register a request and return the promise the adapter awaits. The promise
   * resolves when the user answers and never rejects; if nobody ever answers,
   * the turn simply stays `running` (cancellation is a later ticket).
   */
  request(session_id: string, request_id: string): Promise<'allow' | 'deny'> {
    return new Promise((resolve) => {
      this.pending.set(request_id, { session_id, resolve });
    });
  }

  /**
   * Resolve a request. Only succeeds when a request with this id is pending
   * AND it belongs to `session_id` — a permission answer is always scoped to
   * the session that asked, so a stale or cross-session answer is rejected.
   * Returns false when there is nothing to resolve.
   */
  resolve(session_id: string, request_id: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(request_id);
    if (!entry || entry.session_id !== session_id) return false;
    this.pending.delete(request_id);
    entry.resolve(decision);
    return true;
  }

  /** Number of outstanding requests — used to assert broker state in tests. */
  get size(): number {
    return this.pending.size;
  }
}
