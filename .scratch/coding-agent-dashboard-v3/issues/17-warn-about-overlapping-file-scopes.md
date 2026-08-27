# 17: Warn about overlapping file scopes

**What to build:** When parallel execution is enabled, show risk warnings for deliveries that declare or infer overlapping file scopes, so the user can understand potential conflict before multiple members modify the same project directory.

**Blocked by:** 16: Enable configurable cross-member parallelism.

**Status:** ready-for-agent

- [ ] Leader assignments can optionally include expected file scope metadata.
- [ ] The team UI warns when pending or running deliveries have overlapping expected scopes.
- [ ] Tool activity can surface touched-file hints when available from tool inputs or outputs.
- [ ] Warnings do not block execution in this ticket; they only inform the user.
- [ ] Tests cover declared-scope overlap, inferred touched-file hints, and non-overlapping cases.
