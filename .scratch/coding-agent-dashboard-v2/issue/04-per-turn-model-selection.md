# 04: Per-turn model selection

**What to build:** Before each agent turn, a developer can select a model available to that coding agent in the current environment. The accepted model is persisted in dashboard session metadata and remains visible after reload. If discovery has no models, the developer can send with the agent default; if selection fails, the old choice remains and the turn is not sent.

**Blocked by:** #03 — Expand adapter capabilities for v2 operations.

**Status:** ready-for-agent

- [ ] The composer exposes current-agent model choices and the stored session selection before sending a turn.
- [ ] Only models reported available by the active agent are selectable; an empty list provides a clear default-model fallback.
- [ ] The dashboard persists a model only after the agent accepts the switch.
- [ ] A rejected switch preserves the stored model and provides an actionable error without dispatching the prompt.
- [ ] Model discovery, selection, persistence, fallback, and failure are verified through the public dashboard boundary.
