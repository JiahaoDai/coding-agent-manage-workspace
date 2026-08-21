# 05: Native agent slash commands

**What to build:** A developer can discover and execute the active coding agent's native `/command` operations from the dashboard composer. Commands show concise descriptions and autocomplete, use the agent's command semantics, and preserve that agent's normal permission confirmation flow.

**Blocked by:** #03 — Expand adapter capabilities for v2 operations.

**Status:** ready-for-agent

- [ ] Typing the slash-command prefix exposes commands currently supported by the selected coding agent with concise descriptions.
- [ ] Selecting and submitting a native command dispatches it through the agent's native command mechanism, not as a normal prompt.
- [ ] Native-command tool side effects continue through the existing permission request and response flow.
- [ ] Unsupported commands produce a clear user-visible failure and are never silently sent as ordinary conversation text.
- [ ] Command discovery, dispatch, permissions, and unsupported-command behaviour are covered at the public dashboard boundary.
