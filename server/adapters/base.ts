import type {
  AgentAdapter,
  CapabilityResult,
  ModelOption,
  NativeCommand,
  PromptHandlers,
  ShellCommandResult,
} from '../../shared/adapter';
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

  async getMessages(_real_session_id: string, _cwd: string): Promise<Message[]> {
    return [];
  }

  async listModels(_cwd: string): Promise<CapabilityResult<ModelOption[]>> {
    return unsupported('model discovery');
  }

  async setModel(
    _real_session_id: string,
    _cwd: string,
    _model_id: string,
  ): Promise<CapabilityResult<void>> {
    return unsupported('model selection');
  }

  async listNativeCommands(
    _real_session_id: string,
    _cwd: string,
  ): Promise<CapabilityResult<NativeCommand[]>> {
    return unsupported('native slash commands');
  }

  async runNativeCommand(
    _real_session_id: string,
    _cwd: string,
    _command: string,
    _handlers: PromptHandlers,
  ): Promise<CapabilityResult<void>> {
    return unsupported('native slash commands');
  }

  async runShellCommand(
    _real_session_id: string,
    _cwd: string,
    _command: string,
  ): Promise<CapabilityResult<ShellCommandResult>> {
    return unsupported('direct shell commands');
  }

  abstract createSession(cwd: string, opts?: { name?: string }): Promise<{ real_session_id: string }>;

  abstract prompt(
    real_session_id: string,
    cwd: string,
    input: string,
    handlers: PromptHandlers,
  ): Promise<void>;
}

function unsupported<T>(capability: string): CapabilityResult<T> {
  return { supported: false, reason: `This agent does not support ${capability}.` };
}
