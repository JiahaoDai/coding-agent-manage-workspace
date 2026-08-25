# 11: Persist and reload team run history

**What to build:** Let users leave and return to a team chat while preserving team runs, messages, deliveries, statuses, summaries, and final results, without copying full native agent transcripts into team storage.

**Blocked by:** 10: Handle final, waiting-user, and planning-error states.

**Status:** completed

- [x] Reloading the app restores team list, selected team, prior runs, messages, deliveries, statuses, and final answers.
- [x] Team storage contains collaboration metadata and summaries, not full member native transcripts.
- [x] Opening a delivery can still link back to or load the member's underlying session history when needed.
- [x] Deleted or missing member sessions are shown as recoverable broken references rather than crashing the team view.
- [x] Tests cover reload, history rendering, metadata-only storage, and missing-session handling.
