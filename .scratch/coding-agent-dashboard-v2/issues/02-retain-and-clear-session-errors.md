# 02: Retain and clear dashboard session errors

**What to build:** A dashboard session retains the latest adapter or SDK failure as actionable metadata while the failure is current, and clears it after the next successful agent turn. The conversation continues to show the normal error event without creating a duplicate persisted message. A direct shell command's non-zero exit remains only a command result.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Existing SQLite session records migrate without loss and can store a nullable latest error.
- [x] An adapter or SDK failure marks the session as error and records its latest error.
- [x] A subsequent successful agent turn clears the recorded latest error.
- [x] A non-zero direct-shell exit cannot enter the adapter/SDK error path; ticket 06 will emit its command result without calling the dedicated error recorder.
- [x] REST and SSE behaviour expose the correct session state across a restart.

**Verified:** SQLite migration unit tests, the REST/SSE failure-and-recovery integration test, TypeScript typecheck, production build, and the full test suite (98 tests) pass.
