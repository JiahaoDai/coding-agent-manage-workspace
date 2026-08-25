import { describe, expect, it } from 'vitest';
import { isDisplayableStreamEvent, messagesToConversation } from './conversation';

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

describe('isDisplayableStreamEvent', () => {
  it('treats every streamed conversation event as the first visible response', () => {
    expect(isDisplayableStreamEvent({ type: 'text_delta', text: 'hello' })).toBe(true);
    expect(isDisplayableStreamEvent({ type: 'thinking_delta', text: 'considering' })).toBe(true);
    expect(isDisplayableStreamEvent({ type: 'tool_call_start', tool_call_id: 'tool-1', name: 'Bash', input: {} })).toBe(true);
    expect(isDisplayableStreamEvent({ type: 'tool_call_end', tool_call_id: 'tool-1' })).toBe(true);
    expect(isDisplayableStreamEvent({ type: 'status_note', text: 'Retrying' })).toBe(true);
    expect(isDisplayableStreamEvent({ type: 'error', message: 'failed' })).toBe(true);
  });
});
