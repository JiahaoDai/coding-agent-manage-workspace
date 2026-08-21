# 06: Direct user shell commands

**What to build:** A developer can run `! command` directly in the dashboard session's working directory. The command is an explicit user-authorised action, so it bypasses agent permission confirmation. Its stdout, stderr, and exit status appear in a dedicated result block, but are excluded from the agent's prompt context; command failure does not prevent further conversation.

**Blocked by:** #03 — Expand adapter capabilities for v2 operations.

**Status:** ready-for-agent

- [ ] A composer entry beginning with `!` executes in the dashboard session working directory without an agent permission dialog.
- [ ] Command results show stdout, stderr, and exit status as a dedicated conversation result block.
- [ ] Direct-shell output is not injected into future agent prompt context or native conversation history.
- [ ] A non-zero exit is shown as a command failure while the dashboard session stays available for subsequent turns.
- [ ] Execution, output, context exclusion, and failure behaviour are verified through the public dashboard boundary.
