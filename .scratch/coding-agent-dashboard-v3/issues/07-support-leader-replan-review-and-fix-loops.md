# 07: Support leader re-plan, review, and fix loops

**What to build:** Allow leader follow-up deliveries to produce new plan JSON after seeing member results, so the team can ask a reviewer to review, ask a worker to fix issues, or continue with another member before producing final output.

**Blocked by:** 06: Route member outbound messages back to leader.

**Status:** ready-for-agent

- [ ] Leader follow-up deliveries can return a new `plan` that creates additional assignments in the same run.
- [ ] Review and fix loops can proceed sequentially without losing prior delivery context.
- [ ] `max_rounds` prevents infinite leader/member loops and surfaces a clear stop state.
- [ ] The team timeline shows each re-plan step and the deliveries it created.
- [ ] Tests cover a leader-plan -> worker-result -> leader-replan -> reviewer-review -> leader-final flow.
