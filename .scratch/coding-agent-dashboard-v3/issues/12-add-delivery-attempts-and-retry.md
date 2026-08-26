# 12: Add delivery attempts and retry

**What to build:** Let a failed delivery be retried as a new attempt while preserving the failed attempt's stream, error, timestamps, and status. The user should be able to inspect both attempts separately.

**Blocked by:** 11: Persist and reload team run history.

**Status:** ready-for-agent

- [ ] A failed delivery can be retried without overwriting the previous attempt's output.
- [ ] Stream events are grouped by attempt as well as delivery.
- [ ] The UI shows failed and retried attempts distinctly.
- [ ] Retrying respects global sequential scheduling and dependency rules.
- [ ] Tests cover retry creation, attempt stream isolation, and retry success/failure states.

## Clarified retry semantics

Retry is leader-requested or orchestrator-controlled; it is not a manual user
button and not something a worker member should decide to do autonomously at the
team-delivery layer.

`max_attempts = 3` applies to a single delivery. In other words, the same
`delivery_id` targeting the same member/role for the same task may produce up to
three execution attempts. It is not a run-wide limit and not a global per-role
limit.

Automatic retry is only for transient, recoverable failures, such as:

- LLM/provider request timeout.
- Temporary network interruption.
- Rate limiting where the provider indicates the request can be retried.
- Temporary 5xx/provider unavailable errors.
- Adapter-level transient failures.

Automatic retry must use delayed backoff instead of retrying immediately:

- Attempt 1 fails with a retryable error: wait 30 seconds before attempt 2.
- Attempt 2 fails with a retryable error: wait 60 seconds before attempt 3.
- Attempt 3 fails: stop automatic retry and report the failed delivery to the
  leader.

Non-retryable failures must not be automatically retried. Examples include:

- Billing/quota exhausted or missing API key.
- Permission denied by the user.
- Invalid parameters or malformed task input.
- Missing file/path/dependency.
- Command/tool execution failure that needs a plan change.
- Worker explicitly reports `FAILED: ...`.

When a delivery exhausts retryable attempts, or fails with a non-retryable
error, the orchestrator should preserve every attempt and send the failure
context back to the leader. The leader then decides whether to re-plan, ask the
user for input, switch members/tools, skip the failed task, or finish with an
error.

Retry scheduling must still obey the global sequential worker delivery rules and
delivery dependency rules. A retry attempt should only become claimable once its
backoff delay has elapsed and its dependencies are satisfied.
