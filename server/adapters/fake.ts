import { randomUUID } from 'node:crypto';
import type { PromptHandlers } from '../../shared/adapter';
import { BaseAdapter } from './base';

/**
 * In-process adapter that keeps the app usable before any real agent adapter
 * lands (tickets #9–#11). It satisfies the full `AgentAdapter` contract via
 * `BaseAdapter` (the no-op parts) plus a scripted turn here.
 *
 * `prompt` drives a short scripted turn — thinking, text, a tool call, then a
 * completed status — so the streaming UI is exercisable end-to-end. Registered
 * only in the dev server (`server/index.ts`), never under test.
 */
export class FakeAdapter extends BaseAdapter {
  async createSession(_cwd: string): Promise<{ real_session_id: string }> {
    return { real_session_id: `fake-${randomUUID()}` };
  }

  async prompt(
    _real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    handlers.onThinkingDelta(`Let me think about "${input}" in ${cwd}…`);
    await pause(250);

    handlers.onTextDelta(`Got it — "${input}". Here's what I'll do:`);
    await pause(200);

    const toolId = `fake-tool-${randomUUID()}`;
    handlers.onToolCallStart(toolId, 'Bash', { command: `ls -la ${cwd}` });
    await pause(350);
    handlers.onToolCallEnd(toolId);

    handlers.onTextDelta("\nThat's the walkthrough for this fake turn.");
    await pause(150);

    handlers.onStatusChange('completed');
  }
}
