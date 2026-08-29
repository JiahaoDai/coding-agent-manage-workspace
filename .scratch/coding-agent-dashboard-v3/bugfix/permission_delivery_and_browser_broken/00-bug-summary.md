# Permission Delivery And Browser Broken Bug Summary

> Status: draft
> Date: 2026-08-29
> Scope: Agent Team delivery stream rendering, permission recovery, and stuck running delivery behavior.

## Background

Agent Team execution uses SSE for server-to-client streaming and REST POST for client-to-server actions such as sending messages and answering permission requests.

During a team run, a browser crash or refresh can drop the in-memory frontend permission queue. If the backend process is still alive, the pending permission promise remains in the server `PermissionBroker`, but the refreshed browser does not know about the old request.

This creates a confusing state: the new SSE connection can receive future stream events, but the permission modal that would unblock the current delivery is gone.

## Observed Case

Team:

```text
team_id = 2115aac0-a33d-46d3-a995-80247c0a6f75
```

Blocked delivery:

```text
message_id = e696f983-094d-4bc6-ac28-e71211b82481
delivery_id = 386720e9-6096-4c43-8f48-b19718ca281f
member = backend-coder
session_id = 23911918-9b15-4dda-9bb9-3f4b0cee1743
```

Database state:

```text
team_message_delivery.status = running
team_delivery_attempt.status = running
team_member.status = waiting_permission
session.status = running
```

Last normal Pi tool call:

```text
tool_call_id = call_00_gdWDPQS4pD83FRg4GT8T2997
permission_request_id = pi-call_00_gdWDPQS4pD83FRg4GT8T2997
tool = bash
```

Manual recovery succeeded by POSTing an allow response:

```bash
curl -sS -X POST "http://localhost:4000/api/sessions/23911918-9b15-4dda-9bb9-3f4b0cee1743/permission" \
  -H 'content-type: application/json' \
  --data-binary '{"request_id":"pi-call_00_gdWDPQS4pD83FRg4GT8T2997","decision":"allow"}'
```

Because this worked, the backend process had not crashed and the in-memory pending permission still existed.

## Symptoms

- Browser page shows a system/browser crash during a long Agent Team run.
- After refresh, the page reconnects and can receive new SSE stream events.
- The already-sent permission modal does not reappear.
- The delivery remains `running`.
- The member remains `waiting_permission`.
- Dependent deliveries remain blocked because the current delivery never reaches `done` or `failed`.

## Cause 1: Unbounded Delivery Stream Rendering

The frontend currently appends delivery stream deltas into React state for each `delivery_stream` timeline item. Long-running agents can produce very large text, thinking output, tool calls, and command output.

Likely pressure points:

- `team_text_delta` keeps appending text to an in-memory timeline item.
- `ActivityText` renders accumulated delivery stream text through `ReactMarkdown`.
- `rehypeHighlight` can be expensive for very large code or command-output blocks.
- `PermissionModal` renders full tool input with `JSON.stringify(request.input, null, 2)`.

The agent native transcript remains the source of full history. The browser does not need to keep and render unlimited delivery stream text.

## Cause 2: Permission Request Is Not Recoverable After Refresh

Current permission flow:

```text
agent tool call
  -> server broadcasts permission_request once over SSE
  -> PermissionBroker stores pending request in memory
  -> frontend stores request in React state
  -> user allow/deny POST resolves PermissionBroker promise
```

Refresh/crash failure mode:

```text
browser crash or refresh
  -> old SSE connection closes
  -> React permissionQueue is lost
  -> new SSE connection opens
  -> old permission_request is not replayed
  -> server still waits on PermissionBroker promise
  -> delivery remains running
```

If the backend process also restarts, the DB can still say `running`, but the in-memory pending promise is gone. In that case a permission answer cannot recover the delivery; the delivery must be cancelled, marked interrupted, or retried.

## Desired Direction

Split the fix into two independent tickets:

1. Limit frontend delivery stream memory and rendering cost.
2. Persist and recover pending permission requests across browser refresh, while detecting stale requests after backend restart.

These fixes are complementary:

- Stream truncation reduces the chance of browser crashes.
- Permission recovery makes browser refresh non-fatal for running deliveries.

