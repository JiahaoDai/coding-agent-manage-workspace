# 15: Add worktree isolation mode

**What to build:** Let advanced users create a team where members work in isolated git worktrees, so parallel coding work can happen on separate branches and be merged with explicit user visibility.

**Blocked by:** 13: Enable configurable cross-member parallelism.

**Status:** ready-for-agent

- [ ] A team can be created in an optional worktree isolation mode when the selected project supports it.
- [ ] Each member receives its own worktree-backed working directory and branch identity.
- [ ] The UI shows each member's worktree/branch and merge status.
- [ ] The app exposes a user-visible path for reviewing and merging completed member work.
- [ ] Tests cover eligible and ineligible projects, worktree creation failures, member cwd assignment, and merge/conflict status display.
