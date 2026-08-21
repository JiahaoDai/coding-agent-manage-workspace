# 03: Expand adapter capabilities for v2 operations

**What to build:** Establish a backward-compatible shared adapter and event capability contract for model discovery and selection, native agent commands, and direct user shell commands. Every registered coding agent and the fake adapter remains compatible with ordinary dashboard conversation while exposing the new capability seams needed by later v2 work.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Shared dashboard contracts express model options, model selection, native command discovery/execution, and direct-shell results without leaking one agent's SDK shape to the client.
- [x] Registered adapters and the fake adapter preserve existing create, history, prompt, event, and permission behaviour.
- [x] Unsupported agent capabilities are represented explicitly rather than silently treated as normal prompts.
- [x] Contract tests demonstrate compatible behaviour at the adapter boundary.

**Verified:** adapter contract and existing adapter tests, TypeScript typecheck, production build, and the full test suite (99 tests) pass.
