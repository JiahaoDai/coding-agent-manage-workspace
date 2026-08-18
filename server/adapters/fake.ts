import { randomUUID } from 'node:crypto';
import type { PromptHandlers } from '../../shared/adapter';
import type { NativeSession } from '../../shared/session';
import { BaseAdapter } from './base';

/**
 * In-process adapter that keeps the app usable before any real agent adapter
 * lands (tickets #9–#11). It satisfies the full `AgentAdapter` contract via
 * `BaseAdapter` (the no-op parts) plus a scripted turn here.
 *
 * `prompt` drives a short scripted turn — thinking, text, an interactive
 * permission request for a Bash command, then a completed status — so the
 * streaming UI (including the permission modal) is exercisable end-to-end.
 * Registered only in the dev server (`server/index.ts`), never under test.
 *
 * A simulated native store backs `listSessions`, standing in for the agent's
 * on-disk session store. It lives for the process lifetime and is separate
 * from the app's SQLite store, so a soft-deleted session stays importable
 * (ticket #6).
 */
export class FakeAdapter extends BaseAdapter {
  private readonly native = new Map<string, { cwd: string; name: string }>();

  async createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }> {
    const real_session_id = `fake-${randomUUID()}`;
    this.native.set(real_session_id, { cwd, name: opts?.name ?? 'fake session' });
    return { real_session_id };
  }

  async listSessions(cwd: string): Promise<NativeSession[]> {
    return [...this.native.entries()]
      .filter(([, entry]) => entry.cwd === cwd)
      .map(([real_session_id, entry]) => ({
        real_session_id,
        summary: entry.name,
        cwd: entry.cwd,
      }));
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

    // Demonstrate the interactive permission gate: the agent wants to run a
    // command, so it asks before touching anything. The turn only continues
    // once the user allows or denies from the modal.
    const command = `ls -la ${cwd}`;
    const permissionId = `fake-perm-${randomUUID()}`;
    const decision = await handlers.onPermissionRequest(permissionId, 'Bash', { command });

    if (decision === 'allow') {
      const toolId = `fake-tool-${randomUUID()}`;
      handlers.onToolCallStart(toolId, 'Bash', { command });
      await pause(350);
      handlers.onToolCallEnd(toolId);
      handlers.onTextDelta(`\nRan \`${command}\` — it looks fine.`);
    } else {
      // Denial is reported back: the agent stops that action and adjusts.
      handlers.onTextDelta(`\nSkipped \`${command}\` because you denied permission. Proceeding without it.`);
    }
    await pause(150);

    handlers.onTextDelta("\nThat's the walkthrough for this fake turn.");
    await pause(150);

    handlers.onStatusChange('completed');
  }
}
