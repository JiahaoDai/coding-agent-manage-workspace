# 09: Scope permission requests to team deliveries

**What to build:** Preserve the existing permission confirmation flow while adding team context, so a permission request triggered during a team delivery clearly identifies the team, run, member, delivery, session, working directory, tool, and input.

**Blocked by:** 05: Execute worker deliveries with global sequential scheduling.

**Status:** completed

- [x] Permission requests from team member sessions still require explicit allow/deny.
- [x] The permission modal identifies the source team, run, member role, agent, session, cwd, tool name, and tool input.
- [x] The owning member/delivery is highlighted in the team run view while permission is pending.
- [x] A permission response resumes or denies the correct underlying member delivery.
- [x] Tests cover permission source attribution, response routing, and no regression for ordinary session permissions.
