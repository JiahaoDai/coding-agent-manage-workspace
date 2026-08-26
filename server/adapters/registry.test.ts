import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../shared/adapter';
import { AdapterRegistry } from './registry';

function makeAdapter(close?: AgentAdapter['close']): AgentAdapter {
  return {
    async createSession() {
      return { real_session_id: 'real-1' };
    },
    async openSession(real_session_id) {
      return { real_session_id };
    },
    async listSessions() {
      return [];
    },
    async getMessages() {
      return [];
    },
    async prompt() {},
    async listModels() {
      return { supported: false, reason: 'unused' };
    },
    async setModel() {
      return { supported: false, reason: 'unused' };
    },
    async listNativeCommands() {
      return { supported: false, reason: 'unused' };
    },
    async runNativeCommand() {
      return { supported: false, reason: 'unused' };
    },
    async runShellCommand() {
      return { supported: false, reason: 'unused' };
    },
    close,
  };
}

describe('AdapterRegistry', () => {
  it('closes registered adapters that own resources', async () => {
    const close = vi.fn();
    const registry = new AdapterRegistry();
    registry.register('opencode', makeAdapter(close));

    await registry.closeAll();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
