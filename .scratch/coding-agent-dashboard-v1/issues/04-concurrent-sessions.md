# 04 — Concurrent sessions

**What to build:** Multiple sessions run at once, each streaming independently with a correct status, and permission requests never cross between windows.

**Blocked by:** #2 — Streaming conversation: text + tool calls + thinking (collapsed); #3 — Interactive permission confirmation

**Status:** done

- [x] Two or more sessions can run concurrently.
- [x] Each session's stream and status stay independent (no cross-talk between sessions).
- [x] A permission request from one session routes only to that session's window.
