# 01 — Walking skeleton: create & list a session (fake agent)

**What to build:** The app boots to a session list and a create form. Filling in a directory, choosing an agent, and giving it a name creates a session that appears in the list — driven by a fake agent and persisted in SQLite. This first end-to-end path also lays the scaffold: the monorepo layout, the shared adapter interface contract, the SQLite session table, the REST create/list endpoints, the SSE stream, the in-process fake adapter, and the test harness.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A user can create a session by supplying a directory, choosing an agent, and giving it a name.
- [ ] The new session appears in the list with its name, agent, directory, and status.
- [ ] Sessions persist across a server restart (SQLite is the single source of truth).
- [ ] The shared adapter interface contract is defined and the fake adapter satisfies it.
- [ ] Tests drive the server over REST with a fake adapter and a temporary SQLite database.
