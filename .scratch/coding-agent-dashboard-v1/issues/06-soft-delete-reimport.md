# 06 — Soft delete + re-import

**What to build:** Deleting a session removes it from the interface but leaves the agent's native session intact, so it can be re-imported later.

**Blocked by:** #5 — Session list: filter, search, status badges

**Status:** ready-for-agent

- [ ] Deleting removes the SQLite record and the session disappears from the list.
- [ ] The agent's native session is not deleted on soft delete.
- [ ] A deleted session can be re-imported from the agent's native store.
