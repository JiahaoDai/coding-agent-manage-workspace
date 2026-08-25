import { describe, expect, it } from 'vitest';
import { appendTeamStreamDelta } from './App';
import type { ServerEvent } from './types';

function delta(
  text: string,
  stream_kind: Extract<ServerEvent, { type: 'team_text_delta' }>['stream_kind'] = 'text',
  stream_label?: string,
): Extract<ServerEvent, { type: 'team_text_delta' }> {
  return {
    type: 'team_text_delta',
    team_id: 'team-1',
    run_id: 'run-1',
    delivery_id: 'delivery-1',
    member_id: 'member-1',
    text,
    stream_kind,
    stream_label,
  };
}

describe('appendTeamStreamDelta', () => {
  it('merges consecutive thinking deltas into one readable process block', () => {
    let text = 'user_request:\n支付是如何进行设计的。\n\nStream:\n';
    text = appendTeamStreamDelta(text, delta('The', 'thinking'));
    text = appendTeamStreamDelta(text, delta(' user', 'thinking'));
    text = appendTeamStreamDelta(text, delta(' asks', 'thinking'));
    text = appendTeamStreamDelta(text, delta('{"type":"final"}', 'text'));

    expect(text).toBe('user_request:\n支付是如何进行设计的。\n\nStream:\n[thinking] The user asks\n\n{"type":"final"}');
  });

  it('keeps tool and status events as labeled lines', () => {
    let text = '';
    text = appendTeamStreamDelta(text, delta('Bash tc-1 {"command":"npm test"}', 'tool', 'tool start'));
    text = appendTeamStreamDelta(text, delta('Running tests.', 'status', 'status'));

    expect(text).toBe('[tool start] Bash tc-1 {"command":"npm test"}\n[status] Running tests.\n');
  });

  it('repairs legacy prefixed thinking lines from older event payloads', () => {
    let text = '';
    text = appendTeamStreamDelta(text, { ...delta('\n[thinking] The\n'), stream_kind: undefined } as unknown as Extract<ServerEvent, { type: 'team_text_delta' }>);
    text = appendTeamStreamDelta(text, { ...delta('\n[thinking]  user\n'), stream_kind: undefined } as unknown as Extract<ServerEvent, { type: 'team_text_delta' }>);

    expect(text).toBe('[thinking] The user');
  });
});
