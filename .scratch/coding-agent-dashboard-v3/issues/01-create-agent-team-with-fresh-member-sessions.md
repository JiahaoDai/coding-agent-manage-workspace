# 01: Create agent teams with fresh member sessions

**What to build:** Let the user create an agent team for one project directory, choose member roles from presets or custom prompts, pick each member's agent/model, and have the app create a fresh underlying session for every member. The created team should appear in the UI with its members and be ready for team runs.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A user can create a team with a name, one `cwd`, and at least one leader member plus optional worker/reviewer members.
- [ ] Each member gets a newly created dashboard session; existing ordinary sessions are not reused.
- [ ] Member initialization prompts are sent once per member session and are not repeated during later deliveries.
- [ ] The team and members persist across app reloads.
- [ ] Tests cover team creation, member/session uniqueness, and role template/custom role creation.
