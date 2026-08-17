# 02 — Streaming conversation: text + tool calls + thinking (collapsed)

**What to build:** Opening a session and sending a message streams the reply live. Text appears incrementally; tool calls (name + arguments) and thinking render collapsed by default. The session's status moves to running during the turn and back to completed when it finishes.

**Blocked by:** #1 — Walking skeleton: create & list a session (fake agent)

**Status:** ready-for-agent

- [ ] Sending a message streams the reply text incrementally over SSE.
- [ ] Tool calls are shown with their name and arguments, collapsed by default.
- [ ] Thinking output is shown, collapsed by default.
- [ ] The session's status is `running` during a turn and `completed` after it finishes.
- [ ] Every event carries a `session_id` and reaches the correct session.
