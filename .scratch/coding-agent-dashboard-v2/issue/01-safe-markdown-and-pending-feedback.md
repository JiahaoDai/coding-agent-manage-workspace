# 01: Safe assistant Markdown and pending-turn feedback

**What to build:** Assistant replies render as safe GitHub Flavored Markdown with highlighted code blocks, while user text, thinking, and tool diagnostics retain their plain-text meaning. After a user sends a normal prompt, the conversation shows a dynamic assistant-side loading indicator until the first displayable event or terminal error arrives.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Assistant response text renders GFM constructs and highlighted code without interpreting raw HTML.
- [ ] User messages, thinking, tool data, and command output remain plain-text or structured diagnostic UI.
- [ ] A transient dynamic loading indicator starts on normal prompt submission and clears on the first displayable event or terminal error.
- [ ] Existing native-history display and streamed conversation behaviour remain intact.
