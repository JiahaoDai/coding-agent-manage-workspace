# 08: Render delivery streams and team activity

**What to build:** Make each member's delivery expandable in the team run timeline, with live text, thinking, tool calls, status notes, errors, and a compact activity stream that shows the team progressing through leader, worker, reviewer, and final steps.

**Blocked by:** 05: Execute worker deliveries with global sequential scheduling.

**Status:** ready-for-agent

- [ ] Stream events are grouped by run, member, delivery, and attempt when available.
- [ ] A running delivery can be expanded to show live output without mixing it with another delivery.
- [ ] Completed deliveries show concise summaries by default and detailed process output when expanded.
- [ ] The activity stream shows planning, queued, blocked, running, done, failed, and finalization events.
- [ ] Tests cover stream grouping, expandable delivery details, and activity ordering.
