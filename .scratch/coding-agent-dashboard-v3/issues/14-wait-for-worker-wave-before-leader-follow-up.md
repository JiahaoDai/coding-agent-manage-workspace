# 14: Wait for worker wave before leader follow-up

**What to build:** Let the orchestrator finish the current wave of non-leader work before waking the leader for follow-up. Worker and reviewer results should collect in the leader inbox while runnable non-leader deliveries remain, so the leader does not make a final or resend decision from a partial view of the wave.

**Blocked by:** 13: Mark orchestrator excerpts as summaries.

**Status:** done

- [x] After a leader plan creates multiple worker or reviewer deliveries, the orchestrator prefers runnable non-leader deliveries before leader follow-up deliveries.
- [x] The leader is awakened when the current wave has no runnable non-leader delivery left, while still respecting blocked dependencies, retries, waiting-user state, and run failure rules.
- [x] A worker result that arrives while another worker delivery is still runnable remains pending in the leader inbox instead of being processed immediately.
- [x] Tests cover a two-worker run where both results are available before the leader follow-up prompt is sent.
- [x] Tests cover that the run does not deadlock when a non-leader delivery is blocked, retry-delayed, failed, or waiting on dependencies.
