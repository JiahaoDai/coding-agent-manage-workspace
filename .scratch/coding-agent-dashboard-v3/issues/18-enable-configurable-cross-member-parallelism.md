# 18: Enable configurable cross-member parallelism

**What to build:** Allow a team to run multiple members at the same time by increasing `max_parallel_members`, while preserving single-member serialization, dependency gating, worktree-backed write isolation, and clear UI status.

**Blocked by:** 17: Add worktree isolation for read-write members.

**Status:** ready-for-agent

- [ ] A team can configure `max_parallel_members` above one.
- [ ] Different members can run concurrently when dependencies allow.
- [ ] The same member still never runs more than one delivery at a time.
- [ ] Cross-member parallel write execution is enabled only when `read_write` members are isolated in worktrees.
- [ ] Same-cwd write parallelism remains disabled by default.
- [ ] `read_only` members may run alongside other members subject to dependency gating and tool policy.
- [ ] The UI clearly distinguishes concurrent running deliveries and each member's execution cwd.
- [ ] Worker results include branch names, touched files when available, and test results for leader-driven merge planning.
- [ ] Leader-driven merge remains the first merge model: leader decides merge order, ordinary final answers do not require user confirmation, and user confirmation is required only for conflict decisions, explicit need-info pauses, and final apply/merge into the user's current branch.
- [ ] Overlapping expected-file warnings are advisory only and should be shown as planning/merge-risk hints, not used as the primary safety mechanism.
- [ ] Tool activity can surface touched-file hints when available from structured tool inputs or outputs.
- [ ] Tests cover team-level concurrency limits, single-member locks, dependency-gated parallel execution, worktree-required write parallelism, readonly concurrent deliveries, and advisory overlap warnings.
