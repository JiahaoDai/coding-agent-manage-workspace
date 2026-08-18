import type { AgentAdapter, PromptHandlers } from '../../shared/adapter';
import type { Message, NativeSession } from '../../shared/session';

/**
 * The no-op half of the `AgentAdapter` contract — `openSession`, `listSessions`,
 * and `getMessages` are identical for every fake we use (the dev demo adapter
 * and the test fakes). Concrete fakes implement `createSession` and `prompt`.
 */
export abstract class BaseAdapter implements AgentAdapter {
  async openSession(real_session_id: string, _cwd: string): Promise<{ real_session_id: string }> {
    return { real_session_id };
  }

  async listSessions(_cwd: string): Promise<NativeSession[]> {
    return [];
  }

  async getMessages(): Promise<Message[]> {
    return [];
  }

  abstract createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }>;

  abstract prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void>;
}
