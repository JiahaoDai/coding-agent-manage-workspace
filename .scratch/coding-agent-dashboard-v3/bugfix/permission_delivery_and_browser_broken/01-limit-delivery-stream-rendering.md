# Ticket 1: Limit Delivery Stream Rendering

> Status: ready
> Area: client
> Priority: high

## Problem

Agent Team delivery streams can grow without bound in browser memory. The frontend appends every `team_text_delta` into the timeline item and then renders the accumulated text with Markdown and syntax highlighting.

Large agent outputs can make the browser slow or crash. If the crash happens while a permission modal is open or while a permission request is pending, the delivery can appear stuck after refresh.

## Goal

Cap the amount of delivery stream text kept and rendered by the browser per delivery attempt.

The full transcript should still live in the native agent session. This ticket only limits the UI's live display buffer.

## Proposed Rule

Use a fixed character budget per delivery stream item:

```ts
const MAX_DELIVERY_STREAM_CHARS = 80_000;
const DELIVERY_STREAM_HEAD_KEEP_CHARS = 8_000;
const DELIVERY_STREAM_TAIL_KEEP_CHARS = 72_000;
```

When a delivery stream exceeds the limit:

```text
keep first 8k chars
insert truncation marker
keep latest 72k chars
```

Example marker:

```text

[stream truncated: omitted 123456 characters]

```

This keeps:

- Initial assignment and context.
- Latest status, errors, and test results.
- A clear indication that middle content was omitted.

## Implementation Notes

- Apply truncation at append time, not just render time.
- Put the logic in the team stream helper if possible, so it is easy to test outside React rendering.
- Preserve existing stream kind decoration behavior.
- Track omitted character count so repeated appends do not produce many markers.
- Keep truncation scoped to `delivery_stream` timeline items.
- Do not truncate persisted agent native messages; this is UI-only.

Suggested helper shape:

```ts
interface TruncatedStreamText {
  text: string;
  omitted_chars: number;
}

function appendBoundedDeliveryStreamText(current: string, delta: string): TruncatedStreamText;
```

If adding metadata to the timeline item is too invasive for the first patch, encode a single marker in the display string and keep the implementation local.

## Permission Modal Guard

Also cap permission argument rendering:

- Format `request.input`.
- If formatted text exceeds a limit, show a truncated preview.
- Provide a small "show full" affordance only if it is cheap enough for the first implementation.

Recommended first limit:

```ts
const MAX_PERMISSION_INPUT_PREVIEW_CHARS = 20_000;
```

## Acceptance Criteria

- A single delivery stream item never keeps more than the configured character budget plus marker text in React state.
- The newest stream output remains visible after truncation.
- The start of the stream remains visible after truncation.
- The UI clearly tells the user content was omitted.
- Permission modal does not render unlimited JSON input by default.
- Existing team stream rendering tests are updated or new tests are added for truncation behavior.

## Tests

Add focused tests for:

- Appending below the limit does not change text.
- Appending above the limit keeps head and tail.
- Omitted character count appears in the marker.
- Repeated appends keep the buffer bounded.
- Permission input preview truncates long JSON safely.

## Non-Goals

- Do not change server-side streaming protocol.
- Do not change agent native transcript storage.
- Do not add virtualized rendering yet.
- Do not solve stale permission recovery in this ticket.

