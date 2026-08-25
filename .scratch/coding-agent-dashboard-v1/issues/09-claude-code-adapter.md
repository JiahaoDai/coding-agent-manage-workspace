# 09 — Claude Code adapter

**What to build:** Real Claude Code sessions run through the interface: create, stream text/tool/thinking, permission via the verified `canUseTool`, and native resume.

**Blocked by:** #2 — Streaming conversation: text + tool calls + thinking (collapsed); #3 — Interactive permission confirmation; #7 — Create-time resume of existing native sessions

**Status:** ready-for-agent

- [ ] Create, stream, and multi-turn conversation work against a real Claude Code session.
- [ ] Permission confirmation works via `canUseTool` (including `AskUserQuestion` clarifications).
- [ ] Resuming an existing native Claude Code session works.
