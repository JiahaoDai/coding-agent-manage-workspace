# 10 — OpenCode adapter

**What to build:** Real OpenCode sessions run through the interface. Verify the `permission` event approve/deny shape and implement resume via re-prompt or fork.

**Blocked by:** #2 — Streaming conversation: text + tool calls + thinking (collapsed); #3 — Interactive permission confirmation; #7 — Create-time resume of existing native sessions

**Status:** ready-for-agent

- [ ] Create, stream, and multi-turn conversation work against a real OpenCode session.
- [ ] The OpenCode `permission` event approve/deny shape is verified and wired (or a documented per-agent fallback applies).
- [ ] Resume works via re-prompt or fork.
