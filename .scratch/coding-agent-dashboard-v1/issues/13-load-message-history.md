# 13 — Load message history on session select

**What to build:** Selecting a session loads its conversation from the agent's native store (via the adapter's `getMessages`, using `real_session_id`), so a refresh — or switching back to a session — repopulates the view instead of showing an empty conversation. Message bodies are still never stored in SQLite (design §4); the native store stays the source of truth for bodies.

**Blocked by:** #1 — Walking skeleton (the adapter contract's `getMessages` + the REST surface)

**Status:** ready-for-agent

- [ ] Selecting a session fetches and displays its message history.
- [ ] History is read from the agent's native store via the adapter's `getMessages`, never from SQLite.
- [ ] A refresh (or re-select) of the same session reloads its history.
- [ ] Live-streamed turns still append on top of loaded history without duplication or clobbering.
- [ ] Loading and error states are shown rather than a silent empty view.
