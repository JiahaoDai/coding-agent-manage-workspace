# 16: Enable configurable cross-member parallelism

**What to build:** Allow a team to opt into running multiple members at the same time by increasing `max_parallel_members`, while preserving single-member serialization, dependency gating, and clear UI status.

**Blocked by:** 15: Process leader inbox as an aggregation batch.

**Status:** ready-for-agent

- [ ] A team can configure `max_parallel_members` above one.
- [ ] Different members can run concurrently when dependencies allow.
- [ ] The same member still never runs more than one delivery at a time.
- [ ] The UI clearly distinguishes concurrent running deliveries.
- [ ] Tests cover team-level concurrency limits, single-member locks, and dependency-gated parallel execution.
