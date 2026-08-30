# Phase 1: Link Dependency Results Correctly

> Status: done
> Priority: high
> Goal: a downstream delivery receives the actual result of each dependency.

## Problem

The current dependency prompt resolves an upstream delivery to the message originally delivered to the upstream member. That message is the assignment, not the member's final output.

For the observed flow, this caused `backend-coder` and `front-coder` to receive a truncated version of "Design the architecture" rather than the Architect's `RESULT` describing the completed design.

## Design

Add a nullable reply relation to worker outbound messages:

```ts
interface TeamMessageRecord {
  // Existing fields...
  in_reply_to_delivery_id: string | null;
}
```

`in_reply_to_delivery_id` means: "this message is the outcome of processing this inbound delivery." It is not the delivery id used to send the result to the leader.

Example:

```text
Architect assignment delivery: 5470f629-...
Architect RESULT message:      40e7ed69-...

RESULT.in_reply_to_delivery_id = 5470f629-...
```

The backend assignment can then resolve its dependency on `5470f629-...` directly to the Architect RESULT.

## Implementation

1. Add `in_reply_to_delivery_id TEXT` to `team_message` with an idempotent SQLite migration.
2. Extend `TeamMessageRecord`, database row types, insert/select queries, and test factories.
3. Pass the completed inbound `delivery.delivery_id` to `createMemberOutboundRoute()` from `routeMemberOutboundToLeader()`.
4. Persist it on the outbound worker message in the same transaction that creates the route to the leader.
5. Replace the dependency lookup in `deliveryPrompt()` with a query/helper that resolves:

```text
downstream dependency
  -> depends_on_delivery_id
  -> message.in_reply_to_delivery_id
  -> upstream outbound RESULT / REVIEW / NEED_INFO / FAILED message
```

6. Validate the resolved message belongs to the same team and run, and that its sender is the member that received the upstream delivery. This prevents an unrelated message from being used as a dependency result.
7. Rename the prompt section from `Dependency summaries` to `Dependency results`.

## Prompt Shape

The prompt should communicate the result as data from the orchestrator, rather than encouraging the worker to search for it:

```text
Dependency results:
- Architect delivery 5470f629: completed successfully
  Result:
  Created ARCHITECTURE.md. The protocol uses ...
  Commit: 50920fa
```

Use a separate dependency-result budget rather than the generic 240-character `compactForPrompt()` budget. A reasonable first policy is a per-result cap of 4,000 characters and an overall dependency-context cap of 12,000 characters. The original result remains available in the message history if it exceeds this budget.

No additional LLM call should be used to generate this summary in the first implementation. The worker's parsed outbound content is the source of truth.

## Status Semantics

The existing scheduler behavior remains valid:

- `success` waits for upstream delivery `done`.
- `finished` waits for any upstream terminal state.

The dependency context must represent the actual result kind. A failed upstream delivery should expose its error for a `finished` dependency; it must not be presented as a successful result.

This phase does not change the definition of `done`. A later change may choose to require a valid `RESULT` for artifact-producing tasks, but that is outside this ticket.

## Acceptance Criteria

- A worker RESULT is stored with the delivery id that it answers.
- A downstream `success` dependency receives the upstream RESULT content, not the assignment content.
- The observed Architect -> backend and Architect -> front flows both show the same Architect RESULT in their dependency context.
- A failed upstream `finished` dependency shows the failure context without being labelled successful.
- Multiple results from one member in one run resolve by `in_reply_to_delivery_id`, never by "latest message from this member".
- Dependency context is bounded without reducing every result to 240 characters.

## Tests

Add focused tests for:

- A result route persists `in_reply_to_delivery_id`.
- The dependency-prompt helper selects an upstream RESULT over the upstream assignment.
- Two deliveries handled by the same member resolve to their own results.
- `finished` dependencies surface upstream errors correctly.
- Long result content is capped by the dependency-specific budget and carries a clear truncation marker.
