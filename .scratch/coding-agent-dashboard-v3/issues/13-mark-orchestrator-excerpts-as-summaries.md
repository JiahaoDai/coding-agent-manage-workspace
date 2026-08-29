# 13: Mark orchestrator excerpts as summaries

**What to build:** Prevent the leader from mistaking prompt-budget excerpts for incomplete worker output. When the orchestrator summarizes prior message bus content for a leader prompt, the prompt should clearly say that the original message may be complete and only the prompt excerpt was shortened.

**Blocked by:** 12: Add delivery attempts and retry.

**Status:** done

- [x] Leader follow-up prompts distinguish current inbound message content from orchestrator-generated excerpts.
- [x] Any shortened message bus item is labeled as a prompt excerpt, not as worker output that ended with an ellipsis.
- [x] The leader is instructed not to treat an excerpt marker as evidence that the original delivery was truncated.
- [x] Tests cover a complete long worker result appearing in leader history without causing a resend request solely because the prompt excerpt is shortened.
