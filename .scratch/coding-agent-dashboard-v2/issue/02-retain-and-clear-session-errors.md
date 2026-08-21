# 02: Retain and clear dashboard session errors

**What to build:** A dashboard session retains the latest adapter or SDK failure as actionable metadata while the failure is current, and clears it after the next successful agent turn. The conversation continues to show the normal error event without creating a duplicate persisted message. A direct shell command's non-zero exit remains only a command result.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Existing SQLite session records migrate without loss and can store a nullable latest error.
- [ ] An adapter or SDK failure marks the session as error and records its latest error.
- [ ] A subsequent successful agent turn clears the recorded latest error.
- [ ] A non-zero direct-shell exit neither marks the session error nor records a latest error.
- [ ] REST and SSE behaviour expose the correct session state across a restart.
