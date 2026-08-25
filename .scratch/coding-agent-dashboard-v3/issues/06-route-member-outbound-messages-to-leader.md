# 06: Route member outbound messages back to leader

**What to build:** Let a worker or reviewer finish a delivery by producing a result, review, need-info, proposal, or failure message, then route that outbound message back to the leader for re-planning instead of ending the run blindly.

**Blocked by:** 05: Execute worker deliveries with global sequential scheduling.

**Status:** completed

- [x] Worker/reviewer outputs are converted into team messages with the right kind.
- [x] V1 routes member outbound messages to leader by default.
- [x] Direct worker-to-worker messages are not delivered directly; they are surfaced to leader for a decision.
- [x] A leader follow-up delivery is created after a member outbound message when the run is still active.
- [x] Tests cover result, review, need-info, proposal, failed, and attempted worker-to-worker routing.
