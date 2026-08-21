import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConversationView } from './ConversationView';

const session = {
  session_id: 'dashboard-session-1',
  coding_agent: 'claude' as const,
  real_session_id: 'native-session-1',
  name: 'Markdown check',
  cwd: '/project',
  status: 'completed' as const,
  model: null,
  last_error: null,
  create_time: 1,
  modify_time: 1,
};

describe('ConversationView assistant rendering', () => {
  it('renders assistant text as GFM without interpreting raw HTML', () => {
    const markup = renderToStaticMarkup(
      <ConversationView
        session={session}
        messages={[
          {
            kind: 'assistant',
            parts: [{ kind: 'text', text: '## Heading\n\n| left | right |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst answer = 42;\n```\n\n<script>alert(1)</script>' }],
          },
        ]}
        onSend={() => {}}
      />,
    );

    expect(markup).toContain('<h2>Heading</h2>');
    expect(markup).toContain('<table>');
    expect(markup).toContain('class="hljs');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
  });

  it('keeps user text plain and displays pending feedback outside message history', () => {
    const markup = renderToStaticMarkup(
      <ConversationView
        session={session}
        messages={[{ kind: 'user', text: '**literal user text**' }]}
        onSend={() => {}}
        awaitingFirstResponse
      />,
    );

    expect(markup).toContain('**literal user text**');
    expect(markup).not.toContain('<strong>literal user text</strong>');
    expect(markup).toContain('aria-label="Agent is responding"');
  });
});
