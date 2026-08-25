# 10: Handle final, waiting-user, and planning-error states

**What to build:** Support the leader's terminal JSON outcomes: final result, need-user-input, and failed planning. The user should understand whether the team finished, is waiting for clarification, or could not parse/validate the leader plan.

**Blocked by:** 07: Support leader re-plan, review, and fix loops.

**Status:** completed

- [x] Leader `final` JSON creates a final message, completes the run, and is shown as the team answer.
- [x] Leader `need_user_input` JSON moves the run into a waiting-user state and displays the question.
- [x] The user can answer a waiting-user run and resume leader orchestration.
- [x] Planning parse/validation failures do not create worker deliveries and show actionable diagnostics.
- [x] Tests cover final, waiting-user/resume, invalid JSON, unknown member, and invalid dependency cases.
