# 03 — Interactive permission confirmation

**What to build:** When the agent wants to run a command or edit a file, the user sees a modal showing the tool name and its arguments and can allow or deny. Allowing lets the agent proceed; denying is reported back so the agent stops or adjusts.

**Blocked by:** #2 — Streaming conversation: text + tool calls + thinking (collapsed)

**Status:** done

- [x] A permission request from the (fake) agent surfaces as a modal showing the tool name and arguments.
- [x] Allow/deny round-trips: allowing proceeds and denying is reported back to the agent.
- [x] The server runs agents in `permissionMode: 'default'` and never uses bypass/accept-edits, so no permission is silently skipped.
- [x] Permission requests are routed to the correct session via `session_id`.
