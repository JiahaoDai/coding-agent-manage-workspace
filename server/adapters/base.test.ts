import { describe, expect, it, vi } from 'vitest';
import type { PromptHandlers } from '../../shared/adapter';
import { BaseAdapter } from './base';

class MinimalAdapter extends BaseAdapter {
  async createSession(): Promise<{ real_session_id: string }> {
    return { real_session_id: 'native-session' };
  }

  async prompt(
    _real_session_id: string,
    _cwd: string,
    _input: string,
    handlers: PromptHandlers,
  ): Promise<void> {
    handlers.onTextDelta('still streams normally');
  }
}

const handlers: PromptHandlers = {
  onTextDelta: vi.fn(),
  onToolCallStart: vi.fn(),
  onToolCallEnd: vi.fn(),
  onThinkingDelta: vi.fn(),
  onStatusNote: vi.fn(),
  onStatusChange: vi.fn(),
  onPermissionRequest: vi.fn(async (): Promise<'allow' | 'deny'> => 'deny'),
};

describe('BaseAdapter v2 capability contract', () => {
  it('reports each unimplemented v2 capability explicitly without changing prompt behaviour', async () => {
    const adapter = new MinimalAdapter();

    await adapter.prompt('native-session', '/project', 'hello', handlers);
    expect(handlers.onTextDelta).toHaveBeenCalledWith('still streams normally');

    await expect(adapter.listModels('/project')).resolves.toMatchObject({ supported: false });
    await expect(adapter.setModel('native-session', '/project', 'model-1')).resolves.toMatchObject({ supported: false });
    await expect(adapter.listNativeCommands('native-session', '/project')).resolves.toMatchObject({ supported: false });
    await expect(adapter.runNativeCommand('native-session', '/project', '/help', handlers)).resolves.toMatchObject({ supported: false });
    await expect(adapter.runShellCommand('native-session', '/project', 'pwd')).resolves.toMatchObject({ supported: false });
  });
});
