# 16: Add team member file access mode

**What to build:** Let users mark each team member as `read_only` or `read_write`, pass that choice through team creation, include it in member prompts, and enforce it through team tool policy before ordinary permission confirmation.

**Blocked by:** 15: Process leader inbox as an aggregation batch.

**Status:** ready-for-agent

- [ ] `TeamMemberRecord` and `TeamMemberInput` include `file_access: "read_only" | "read_write"`.
- [ ] `team_member` persists `file_access`, `execution_cwd`, `worktree_path`, and `worktree_branch` as additive fields.
- [ ] Existing rows are migrated with a documented compatibility default.
- [ ] Team creation UI lets the user choose readonly/read-write per member, with reviewer/tester templates defaulting to `read_only` and coder templates defaulting to `read_write`.
- [ ] `memberInitializationPrompt(...)` and delivery prompts include a workspace policy block with file access, team root cwd, execution cwd, and the rule not to operate outside execution cwd.
- [ ] Leader plan validation rejects write-required implementation/fix assignments sent to `read_only` members.
- [ ] Team permission handling applies file-access policy before ordinary user confirmation.
- [ ] `read_only` members automatically deny structured write tools and clearly mutating shell/git commands.
- [ ] `read_write` members can write only under `execution_cwd`; structured paths outside that cwd are denied.
- [ ] Unclear shell commands still go to user confirmation.
- [ ] Tests cover create-team persistence, prompt content, assignment validation, readonly denials, read-write path boundaries, and unclear-command confirmation.
