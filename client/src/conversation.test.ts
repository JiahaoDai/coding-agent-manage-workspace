import { describe, expect, it } from 'vitest';
import { messagesToConversation } from './conversation';

describe('messagesToConversation (native-store history → display list)', () => {
  it('maps user, assistant, and system messages into the display model', () => {
    expect(
      messagesToConversation([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'system', content: 'compacted' },
      ]),
    ).toEqual([
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', parts: [{ kind: 'text', text: 'hi there' }] },
      { kind: 'system', text: 'compacted' },
    ]);
  });

  it('maps an empty history to an empty list', () => {
    expect(messagesToConversation([])).toEqual([]);
  });
});
