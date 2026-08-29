# Ticket 2: Persist And Recover Pending Permissions

> Status: ready
> Area: server, client
> Priority: high

## Problem

Permission requests are currently recoverable only while the original browser page is alive.

The server stores pending permission requests in an in-memory `PermissionBroker`. The frontend stores visible requests in React state. If the browser crashes or refreshes after the server broadcasts `permission_request`, the new page cannot rediscover that pending request.

If the backend process is still running, a manual POST can still resolve the pending permission. If the backend process restarted, the DB can still show a running delivery even though the in-memory promise is gone.

## Goal

Make pending permission requests recoverable after browser refresh and clearly detect stale permission records after backend restart.

## Data Model

Add a short-lived pending permission store. It is a recovery queue, not a long-term audit log.

Suggested table:

```sql
CREATE TABLE pending_permission (
  permission_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  team_id TEXT,
  run_id TEXT,
  delivery_id TEXT,
  member_id TEXT,
  team_context_json TEXT,
  status TEXT NOT NULL,
  create_time INTEGER NOT NULL,
  resolve_time INTEGER,
  UNIQUE(session_id, request_id)
);
```

Suggested statuses:

```ts
type PendingPermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired';
```

First implementation may immediately delete records after allow/deny instead of keeping `allowed`/`denied` rows. Keep `expired` only if it helps debugging stale state.

## Server Flow

When a permission request is created:

```text
handleTeamPermissionRequest
  -> evaluate team policy
  -> set member waiting_permission
  -> insert pending_permission(status=pending)
  -> broadcast permission_request over SSE
  -> await PermissionBroker.request(...)
```

When user answers:

```text
POST /api/sessions/:id/permission
  -> resolve PermissionBroker
  -> mark/delete pending_permission
  -> broadcast permission_response
```

When delivery finishes, fails, or is cancelled:

```text
cleanup pending_permission where delivery_id = current delivery
```

When team is deleted:

```text
cleanup pending_permission where team_id = deleted team
```

## Recovery Endpoint

Add an endpoint:

```http
GET /api/permissions/pending
```

Return all pending permissions relevant to the current local user.

Response shape:

```ts
interface PendingPermissionResponse {
  permissions: Array<{
    session_id: string;
    request_id: string;
    tool_name: string;
    input: unknown;
    team_context?: TeamPermissionContext;
    recoverable: boolean;
  }>;
}
```

`recoverable` is `true` only when the DB record exists and `PermissionBroker` still has a matching in-memory pending request.

## Frontend Flow

On app startup:

```text
GET /api/permissions/pending
  -> add recoverable permissions to permissionQueue
  -> show stale permissions as recover/retry/cancel guidance if needed
```

On SSE reconnect:

```text
GET /api/permissions/pending
  -> merge into permissionQueue, dedupe by session_id + request_id
```

The existing `permission_request` SSE event remains useful for live requests. The REST endpoint is for refresh/reconnect recovery.

## Backend Restart Handling

After backend restart, `PermissionBroker` memory is empty. DB rows may still exist, but they are not answerable.

On startup or on `GET /api/permissions/pending`:

- If DB row is `pending` but broker has no matching request, return `recoverable: false`, or mark it `expired`.
- Do not allow POST permission response to pretend success when broker has no pending promise.
- Surface that the delivery must be cancelled, marked interrupted, or retried.

This ticket can stop at exposing stale records. A fuller delivery cancel/retry UI can be a follow-up if needed.

## Cleanup Policy

Use short-lived records:

- Delete pending row after successful allow/deny.
- Delete rows for a delivery when the delivery becomes `done`, `failed`, or `cancelled`.
- Delete rows for a team when the team is deleted.
- On startup, expire or delete stale rows whose broker promise cannot exist anymore.
- Optionally delete old `allowed`/`denied`/`expired` rows older than 24 hours if history is kept.

## Acceptance Criteria

- Browser refresh after a pending permission request restores the permission modal when the backend process is still alive.
- Answering a restored permission unblocks the running delivery.
- Duplicate permission modals are not created on repeated refreshes or SSE reconnects.
- If the backend restarted and a DB pending row is stale, the UI does not show a normal allow/deny modal as if it were recoverable.
- Permission rows are cleaned up after allow/deny and after delivery/team cleanup.
- Existing ordinary session permission flow still works.

## Tests

Add server tests for:

- Pending permission record is inserted when team permission request is created.
- POST allow/deny resolves broker and removes or marks the record.
- `GET /api/permissions/pending` returns recoverable records.
- Stale DB pending records are returned as `recoverable: false` or expired.
- Team deletion removes associated pending permission rows.

Add client tests for:

- App startup loads pending permissions into `permissionQueue`.
- Reconnect loading dedupes existing permission requests.
- Stale permission records are rendered as recovery guidance, not an allow/deny modal.

## Non-Goals

- Do not make permission records a permanent audit log.
- Do not auto-allow or auto-deny after refresh.
- Do not implement full delivery retry/cancel UI unless needed to represent stale records.
- Do not change the SSE protocol beyond using it together with REST recovery.

