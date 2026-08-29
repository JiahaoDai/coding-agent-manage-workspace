# Ticket 1: Add Delivery Timeout, Cancel, And Retry

> Status: ready
> Area: server, client
> Priority: high

## Problem

A team delivery can stay `running` forever if the member agent starts a tool call that never returns. The orchestrator currently waits for `adapter.prompt(...)` without a delivery-level timeout or cancellation path.

This blocks dependent deliveries and can leave the whole team run stuck.

## Goal

Give every team delivery attempt a bounded lifecycle:

- Timeout long-running delivery attempts.
- Abort the underlying agent turn when supported by the adapter.
- Mark the attempt and delivery terminal when timeout/cancel happens.
- Let the user manually cancel or retry a stuck delivery.

## Adapter Contract

Extend the adapter interface with optional abort support:

```ts
interface AgentAdapter {
  prompt(...): Promise<void>;
  abort?(real_session_id: string, cwd: string): Promise<void>;
}
```

Expected adapter behavior:

- Claude Code: use its interrupt or abort controller capability.
- OpenCode: call its session abort endpoint when available.
- Pi: call `session.abort()` on the opened session.
- Fake/test adapter: expose deterministic abort behavior for tests.

If an adapter does not support abort, the orchestrator should still mark the delivery failed/cancelled after timeout and show that the underlying adapter may still be running.

## Delivery Timeout

Add a configurable timeout for team delivery attempts.

Suggested default:

```ts
const DEFAULT_TEAM_DELIVERY_TIMEOUT_MS = 10 * 60 * 1000;
```

Optional configuration:

```text
TEAM_DELIVERY_TIMEOUT_MS=600000
```

Timeout flow:

```text
start delivery attempt
  -> Promise.race(adapter.prompt(...), timeout)
  -> on timeout:
       - call adapter.abort if available
       - finish attempt as failed or cancelled
       - set delivery terminal
       - set member idle/error with current_delivery_id cleared
       - set session status to error or cancelled
       - write a clear error message
       - continue orchestrator scheduling
```

Recommended terminal state for automatic timeout:

```text
attempt.status = failed
delivery.status = failed
error = Delivery timed out after <duration>ms
```

Manual user cancellation can use `cancelled`.

## Manual Cancel Endpoint

Add an endpoint:

```http
POST /api/team-deliveries/:delivery_id/cancel
```

Cancel flow:

```text
lookup running delivery
  -> lookup member session and adapter
  -> call adapter.abort if supported
  -> mark current attempt cancelled
  -> mark delivery cancelled
  -> clear member current_delivery_id
  -> set member idle or error
  -> broadcast team_delivery_status
  -> run orchestrator again
```

The endpoint should be idempotent:

- If delivery is already terminal, return ok with current state.
- If adapter abort fails, still mark the delivery cancelled and record abort error.

## Manual Retry Endpoint

Add an endpoint:

```http
POST /api/team-deliveries/:delivery_id/retry
```

Retry flow:

```text
lookup failed/cancelled delivery
  -> clear terminal error
  -> set delivery pending or blocked based on dependency state
  -> create a new attempt when it starts
  -> run orchestrator again
```

Retry should not reuse the old attempt output. It should create a new `team_delivery_attempt` row.

## UI Requirements

In Team Chat / run timeline:

- Show running duration for active deliveries.
- Show timeout errors clearly.
- For running deliveries, expose `Cancel`.
- For failed/cancelled deliveries, expose `Retry`.
- Show whether adapter abort was supported or failed.

Keep the UI small and operational. This is recovery machinery, not a new planning interface.

## Acceptance Criteria

- A delivery that exceeds the configured timeout does not remain `running`.
- Timeout attempts are marked failed with a clear error.
- Member `current_delivery_id` is cleared after timeout/cancel.
- Dependent deliveries are not permanently blocked by a timed-out delivery.
- Manual cancel transitions a running delivery to cancelled.
- Manual retry requeues a failed/cancelled delivery.
- Existing successful delivery flow is unchanged.

## Tests

Add server tests for:

- Timeout marks delivery attempt and delivery failed.(test timeout use little DEFAULT_TEAM_DELIVERY_TIMEOUT_MS)
- Timeout calls adapter abort when supported.
- Timeout still marks delivery failed when adapter abort is unsupported.
- Cancel endpoint is idempotent.
- Retry endpoint requeues failed/cancelled delivery and creates a new attempt on execution.
- Orchestrator continues or reports failed run state after timeout according to existing dependency rules.

Add client tests for:

- Running delivery shows cancel action.
- Failed/cancelled delivery shows retry action.
- Timeout error is rendered in the delivery timeline.

## Non-Goals

- Do not implement per-tool-call timeout in this ticket.
- Do not parse shell commands in this ticket.
- Do not change permission policy here.
- Do not force all adapters to support abort before adding delivery timeout.

