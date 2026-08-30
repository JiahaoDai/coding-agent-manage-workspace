# Dependency Visibility Problem: Phenomenon and Root Cause

> Status: draft
> Date: 2026-08-30
> Scope: Agent Team worktree isolation and delivery dependency context.

## Observed Run

This issue was observed in the following team run:

```text
team_id = 2115aac0-a33d-46d3-a995-80247c0a6f75
```

The leader assigned an architecture task to `Architect`, then assigned implementation tasks to `backend-coder` and `front-coder`. Both implementation deliveries declared a `success` dependency on the Architect delivery.

The Architect delivery completed successfully and created `ARCHITECTURE.md` in its own worktree. Its outbound `RESULT` stated that the document was created and included the architecture decisions and commit information.

However, the worker behavior diverged:

- `backend-coder` received a truncated copy of the Architect assignment, could not find `ARCHITECTURE.md` in its own worktree, and used the assignment's fallback behavior to implement a pragmatic version.
- `front-coder` received the same flawed dependency summary, but searched outside its `execution_cwd`, located the Architect worktree manually, and read `ARCHITECTURE.md` from there.

The second outcome happened to produce better context, but it is not a supported or safe collaboration path.

## Expected Behavior

When a delivery depends on another delivery with `dependency_type = success`:

1. The downstream member receives the actual final result of the upstream delivery, rather than the upstream task assignment.
2. If the upstream member uses a worktree, the downstream member can read the upstream worktree only when it is an explicitly declared dependency.
3. A member can modify only its own `execution_cwd`; it cannot modify an upstream or sibling worktree.

## Failure Chain

```text
leader assignment -> Architect delivery
                    -> Architect RESULT -> leader

backend delivery depends on Architect delivery
                    -> scheduler waits for Architect status = done
                    -> prompt builder reads Architect assignment message
                    -> backend sees a truncated task description, not the RESULT
```

The scheduler correctly enforced execution order. The error is in dependency-context construction, not in the dependency status transition itself.

## Root Causes

### 1. A dependency points to an assignment delivery, not to its result

`team_delivery_dependency.depends_on_delivery_id` correctly points to the upstream assignment delivery. The current prompt builder then follows that delivery's `message_id`, which is necessarily the leader's assignment message.

In [server/app.ts](../../../../server/app.ts), `deliveryPrompt()` reads the upstream assignment at lines 2690-2698:

```ts
const upstream = runItems?.deliveries.find((item) => item.delivery_id === dependency.depends_on_delivery_id);
const upstreamMessage = upstream
  ? runItems?.messages.find((item) => item.message_id === upstream.message_id)
  : undefined;
```

That data path cannot reach the worker's outbound `RESULT` message.

### 2. A worker result has no reply-to-delivery relation

When a worker completes, `routeMemberOutboundToLeader()` creates a new message and a new delivery to the leader. The new message records the sender and content, but not the inbound delivery that caused it.

Without an explicit `in_reply_to_delivery_id`, the server cannot safely distinguish an Architect result for one task from a later Architect result in the same run, nor can it reliably resolve a dependency to the correct result.

### 3. The wrong message is aggressively truncated

`compactForPrompt()` currently uses a 240-character budget. Even if the correct result were selected, a single generic 240-character excerpt is too small for architectural constraints. In the observed run, the truncation compounded the more fundamental wrong-message bug.

### 4. Worktree isolation is not a filesystem permission boundary

`createMemberWorktree()` creates separate worktrees and branches, but all of them remain accessible to processes running as the same user. The delivery prompt says to operate only inside the execution cwd, but this is instruction text, not an enforced write boundary.

Consequently, a member can use an absolute path, `..`, a symlink, or a script to read or write a sibling worktree unless the execution environment rejects that access.

## Resolution Plan

The fix is intentionally split into three stages:

1. [Link dependency results correctly](01-link-dependency-results.md): add a reply-to-delivery relation and put the correct upstream RESULT into downstream prompts.
2. [Expose declared dependency worktrees as read-only](02-readonly-dependency-worktrees.md): permit useful cross-worktree reads while preventing writes outside the member's cwd.
3. [Add stable handoff snapshots when needed](03-stable-handoff.md): optionally replace a live upstream worktree view with an immutable commit or file snapshot.

Stage 1 is required to fix the immediate functional bug. Stage 2 implements the desired write-safety rule. Stage 3 is a future hardening option, not a prerequisite for the first two stages.
