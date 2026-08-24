# 05: Execute worker deliveries with global sequential scheduling

**What to build:** Execute queued worker deliveries one at a time across the whole team run. The orchestrator should build incremental delivery prompts, call the correct member session, mark delivery status, and keep `max_parallel_members` effectively fixed at one.

**Blocked by:** 04: Parse leader plans into queued deliveries.

**Status:** completed

- [x] At most one delivery in a team run can be running at any time.
- [x] Worker delivery prompts include only the current task, necessary context, and dependency summaries, not repeated role/persona history.
- [x] Delivery status moves through pending/running/done or failed and is visible in the team UI.
- [x] Multiple queued deliveries execute in deterministic order when their dependencies are satisfied.
- [x] Tests cover global sequential scheduling, per-member queue order, and prevention of concurrent delivery execution.
