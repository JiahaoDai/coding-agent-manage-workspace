import type { AgentAdapter } from '../../shared/adapter';
import type { AgentId } from '../../shared/session';

/** Maps an agent id to its adapter. Adding an agent means registering a new adapter. */
export class AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();

  register(id: AgentId, adapter: AgentAdapter): void {
    this.adapters.set(id, adapter);
  }

  get(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentId[] {
    return [...this.adapters.keys()];
  }
}
