# 12: Add delivery attempts and retry

**What to build:** Let a failed delivery be retried as a new attempt while preserving the failed attempt's stream, error, timestamps, and status. The user should be able to inspect both attempts separately.

**Blocked by:** 11: Persist and reload team run history.

**Status:** ready-for-agent

- [ ] A failed delivery can be retried without overwriting the previous attempt's output.
- [ ] Stream events are grouped by attempt as well as delivery.
- [ ] The UI shows failed and retried attempts distinctly.
- [ ] Retrying respects global sequential scheduling and dependency rules.
- [ ] Tests cover retry creation, attempt stream isolation, and retry success/failure states.
