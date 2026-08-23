# 02: Open a team chat shell

**What to build:** Let the user open a created team into a team chat workspace that shows the team identity, member list, empty run timeline, and a composer for sending a team request. This ticket makes the team feel like a first-class workspace even before orchestration exists.

**Blocked by:** 01: Create agent teams with fresh member sessions.

**Status:** completed

- [x] A user can select a team from the app and open its team chat view.
- [x] The view shows team name, working directory, members, roles, agents, models, and statuses.
- [x] The team composer accepts a user request but does not need to execute real orchestration yet.
- [x] Empty, loading, and missing-team states are handled cleanly.
- [x] Tests cover opening a team, rendering member metadata, and preserving the current ordinary session workflow.
