# 03: Run a leader-only team request

**What to build:** Let the user send a request in team chat and have the orchestrator create a team run, deliver the request to the leader member only, stream the leader's response, and display the final result in the team timeline.

**Blocked by:** 02: Open a team chat shell.

**Status:** completed

- [x] Sending a team request creates a team run and a user request message.
- [x] The request is delivered to the leader member's fresh underlying session.
- [x] Leader output streams into the team run timeline without duplicating the member initialization prompt.
- [x] A valid leader final result completes the run and is visible to the user.
- [x] Tests cover run creation, leader delivery, streaming, and run completion.
