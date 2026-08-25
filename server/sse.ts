import type { ServerEvent } from '../shared/events';

/** The subset of Hono's SSE stream we depend on, kept here to avoid coupling. */
export interface SseStream {
  writeSSE(data: { event?: string; data: string; id?: string }): Promise<void>;
  onAbort(callback: () => void): void;
}

/**
 * Fan-out hub for the single multiplexed SSE stream. Every connected client is
 * added here; `broadcast` writes an event (tagged with `session_id`) to all of
 * them and each client routes it to the right window.
 */
export class SseHub {
  private readonly streams = new Set<SseStream>();

  add(stream: SseStream): void {
    this.streams.add(stream);
    stream.onAbort(() => this.streams.delete(stream));
  }

  broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const stream of this.streams) {
      // Hono serializes writes per stream, so ordering is preserved; a write
      // failing (client gone) just drops that stream instead of throwing.
      void stream.writeSSE({ event: 'message', data }).catch(() => this.streams.delete(stream));
    }
  }
}
