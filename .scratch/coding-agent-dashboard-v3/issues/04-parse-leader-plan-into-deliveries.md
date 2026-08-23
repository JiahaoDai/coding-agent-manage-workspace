# 04: Parse leader plans into queued deliveries

**What to build:** Let the leader return structured plan JSON and have the orchestrator validate it, render it as a readable plan, and create assignment messages plus queued or blocked deliveries for the named members.

**Blocked by:** 03: Run a leader-only team request.

**Status:** ready-for-agent

- [ ] The leader can return `plan` JSON with summary, assignments, target roles, task text, context, and dependencies.
- [ ] Invalid JSON, unknown member roles, and invalid dependency references do not create deliveries and are shown as planning errors.
- [ ] Valid assignments create team messages and deliveries with stable per-member queue ordering.
- [ ] The team timeline shows planned assignments and queued/blocked delivery states.
- [ ] Tests cover schema validation, role validation, dependency validation, and delivery creation.
