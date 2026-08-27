# 15: Process leader inbox as an aggregation batch

**What to build:** When the leader wakes for follow-up, consume the pending inbound leader deliveries as one aggregation batch. The leader prompt should include the full current batch when it fits the budget, fall back to explicit budget-aware excerpts when it does not, and mark the consumed deliveries consistently so no already-produced result is cancelled just because another leader delivery finished first.

**Blocked by:** 14: Wait for worker wave before leader follow-up.

**Status:** ready-for-agent

- [ ] A leader follow-up prompt can include multiple pending inbound result, review, error, or proposal deliveries in one batch.
- [ ] Current batch content is packed with a clear token budget policy: full content when it fits, explicit orchestrator excerpts when it does not.
- [ ] Consumed leader inbox deliveries are marked as processed together, and remaining cancellation semantics do not hide already-produced results as accidental leftovers.
- [ ] The team run history or activity view makes it understandable that the leader processed multiple inbound deliveries together.
- [ ] Tests cover the TikTok/Xiaohongshu shape: two worker results reach the leader, the leader final uses both, and no complete pending worker result is misread as truncated or cancelled as stale.
