import type { Message, ServerEvent } from './types';

/**
 * Pure conversation-state logic: how user messages and streamed agent events
 * fold into a displayable message list. Kept free of React so the rules are
 * easy to read and test in isolation.
 */

export type ConversationMessage =
  | { kind: 'user'; text: string }
  | AssistantMessage
  | { kind: 'system'; text: string };

export interface AssistantMessage {
  kind: 'assistant';
  parts: AssistantPart[];
}

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool_call_id: string; name: string; input: unknown; done: boolean };

/** The stream events that mutate a conversation (session_id stripped). */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; tool_call_id: string; name: string; input: unknown }
  | { type: 'tool_call_end'; tool_call_id: string }
  | { type: 'error'; message: string };

export type StreamableServerEvent =
  | Extract<ServerEvent, { type: 'text_delta' }>
  | Extract<ServerEvent, { type: 'thinking_delta' }>
  | Extract<ServerEvent, { type: 'tool_call_start' }>
  | Extract<ServerEvent, { type: 'tool_call_end' }>
  | Extract<ServerEvent, { type: 'error' }>;

/**
 * Fold messages read from the agent's native store (adapter `getMessages`) into
 * the display model. History carries text only — tool calls and thinking stream
 * live, they are not replayed as text.
 */
export function messagesToConversation(messages: Message[]): ConversationMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'user':
        return { kind: 'user', text: m.content };
      case 'assistant':
        return { kind: 'assistant', parts: [{ kind: 'text', text: m.content }] };
      case 'system':
        return { kind: 'system', text: m.content };
    }
  });
}

export function toStreamEvent(event: StreamableServerEvent): StreamEvent {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text_delta', text: event.text };
    case 'thinking_delta':
      return { type: 'thinking_delta', text: event.text };
    case 'tool_call_start':
      return {
        type: 'tool_call_start',
        tool_call_id: event.tool_call_id,
        name: event.name,
        input: event.input,
      };
    case 'tool_call_end':
      return { type: 'tool_call_end', tool_call_id: event.tool_call_id };
    case 'error':
      return { type: 'error', message: event.message };
  }
}

export function applyUserMessage(
  messages: ConversationMessage[],
  text: string,
): ConversationMessage[] {
  return [...messages, { kind: 'user', text }];
}

/**
 * Ensure the message list ends with an assistant message, creating one if
 * needed. Returns the list and the assistant message as the last element.
 */
function ensureAssistant(
  messages: ConversationMessage[],
): [ConversationMessage[], AssistantMessage] {
  const last = messages[messages.length - 1];
  if (last && last.kind === 'assistant') return [messages, last];
  const assistant: AssistantMessage = { kind: 'assistant', parts: [] };
  return [[...messages, assistant], assistant];
}

export function applyStreamEvent(
  messages: ConversationMessage[],
  event: StreamEvent,
): ConversationMessage[] {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta': {
      const kind = event.type === 'text_delta' ? 'text' : 'thinking';
      const [withAssistant, last] = ensureAssistant(messages);
      const parts = [...last.parts];
      const prev = parts[parts.length - 1];
      if (prev && prev.kind === kind) {
        // Merge into the running accumulator part.
        parts[parts.length - 1] = { ...prev, text: prev.text + event.text };
      } else {
        parts.push(kind === 'text' ? { kind: 'text', text: event.text } : { kind: 'thinking', text: event.text });
      }
      const next = [...withAssistant];
      next[next.length - 1] = { ...last, parts };
      return next;
    }

    case 'tool_call_start':
      return appendPart(messages, {
        kind: 'tool',
        tool_call_id: event.tool_call_id,
        name: event.name,
        input: event.input,
        done: false,
      });

    case 'tool_call_end':
      return messages.map((message) =>
        message.kind === 'assistant'
          ? {
              ...message,
              parts: message.parts.map((part) =>
                part.kind === 'tool' && part.tool_call_id === event.tool_call_id
                  ? { ...part, done: true }
                  : part,
              ),
            }
          : message,
      );

    case 'error':
      return [...messages, { kind: 'system', text: event.message }];
  }
}

function appendPart(messages: ConversationMessage[], part: AssistantPart): ConversationMessage[] {
  const [withAssistant, last] = ensureAssistant(messages);
  const next = [...withAssistant];
  next[next.length - 1] = { ...last, parts: [...last.parts, part] };
  return next;
}
