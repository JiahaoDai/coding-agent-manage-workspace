# 17: Add worktree isolation for read-write members

**What to build:** When worktree isolation is enabled for a team, create isolated git worktrees for `read_write` members before their backing agent sessions are created, while keeping `read_only` members in the original team cwd.

**Blocked by:** 16: Add team member file access mode.

**Status:** ready-for-agent

- [ ] Team creation can enable worktree isolation only when the selected cwd is inside an eligible git repository.
- [ ] `read_only` members keep `session.cwd = team.cwd`, `execution_cwd = team.cwd`, and null worktree metadata.
- [ ] `read_write` members receive generated worktree paths and branch names before `adapter.createSession(...)` runs.
- [ ] `read_write` member sessions are created with `cwd = execution_cwd`, where `execution_cwd` is the member worktree path.
- [ ] Worktree path and branch names are derived by the server, normalized, and not supplied by the agent.
- [ ] Generated branches use a stable convention such as `agent-team/<team_id>/<member_role>`.
- [ ] Generated paths use a stable convention such as `<repo-parent>/.agent-team-worktrees/<team_id>/<member_role>`.
- [ ] Worktree creation failures prevent team creation and return a user-visible error.
- [ ] The UI shows each member's file access mode, execution cwd, and worktree branch/path when present.
- [ ] Tests cover eligible and ineligible repositories, worktree creation failure, session cwd assignment, readonly member cwd behavior, and persisted worktree metadata.
