## Problem Statement

The coding-agent dashboard v1 has several usability and capability gaps. Assistant responses are shown as plain text instead of Markdown; a user receives no visible feedback between sending a prompt and the first streamed response; model selection is unavailable; native agent slash commands and user shell commands do not execute; and an adapter or SDK failure is not retained as actionable session state.

## Solution

Extend the local, single-user coding-agent dashboard with safe GFM rendering for assistant responses, a transient dynamic loading indicator, per-turn model selection persisted with dashboard session metadata, native `/command` execution, directly authorised `! shell` execution, and recoverable adapter/SDK error tracking. The dashboard continues to treat each agent's native session as the source of truth for conversation bodies and agent-native history.

## User Stories

1. As a developer, I want assistant replies rendered as GitHub Flavored Markdown, so that lists, tables, task lists, and code blocks are easy to read.
2. As a developer, I want code blocks in assistant replies highlighted, so that code is easier to scan.
3. As a developer, I want raw HTML in assistant replies disabled, so that untrusted agent output cannot alter or execute within the dashboard UI.
4. As a developer, I want my own messages to remain plain text, so that the text I submitted is represented exactly.
5. As a developer, I want thinking content and tool information to remain plain-text diagnostic data, so that Markdown interpretation does not obscure debugging details.
6. As a developer, I want to see a dynamic assistant-side loading indicator immediately after sending a prompt, so that I know the dashboard has started processing it.
7. As a developer, I want the loading indicator to disappear when the first text, thinking, tool, permission, or error event is displayable, so that it does not overlap with real progress.
8. As a developer, I want the loading indicator to be transient rather than a recorded conversation message, so that reopening native history does not show a stale pending state.
9. As a developer, I want to choose an available model before sending each turn, so that I can select an appropriate model for the task.
10. As a developer, I want model choices to reflect models currently available to the selected coding agent in my environment, so that I cannot select an unavailable model.
11. As a developer, I want to continue with an agent's default model when model discovery returns no options, so that an unavailable model-list operation does not block a session.
12. As a developer, I want the selected model recorded with the dashboard session, so that the current model remains visible after refresh or restart.
13. As a developer, I want a failed model switch to retain the previously recorded model, so that dashboard metadata stays consistent with the native agent session.
14. As a developer, I want `/command` to run the active agent's native command, so that I can use the agent's configured commands, skills, and plugins.
15. As a developer, I want native commands dynamically listed with concise descriptions, so that I can discover and autocomplete commands supported by the active agent.
16. As a developer, I want an unsupported native command to report a clear error instead of being silently treated as a normal chat prompt, so that command intent is predictable.
17. As a developer, I want native commands to keep the agent's existing permission confirmation flow, so that agent-managed side effects remain controlled.
18. As a developer, I want `! shell-command` to execute in the dashboard session's working directory, so that I can run an explicitly authorised local command alongside the conversation.
19. As a developer, I want explicitly entered `! shell-command` input to bypass the agent permission dialog, so that my direct shell action does not require redundant confirmation.
20. As a developer, I want shell stdout, stderr, and exit status shown as a dedicated command-result block, so that I can inspect its outcome.
21. As a developer, I want shell output excluded from the agent's future prompt context by default, so that command logs do not unexpectedly affect model reasoning or consume context.
22. As a developer, I want a non-zero shell exit status to remain a command result rather than an agent-session error, so that I can continue the conversation.
23. As a developer, I want adapter or SDK failures recorded as the latest session error, so that I can diagnose a failed agent turn.
24. As a developer, I want the current failed turn's error surfaced through the normal conversation and SSE error flow, so that I can see it without a separate duplicated error message.
25. As a developer, I want the retained latest error cleared after the next successful agent turn, so that it represents an unresolved failure rather than stale history.

## Implementation Decisions

- The dashboard remains a local, single-user React client, Node server, SQLite metadata store, multiplexed SSE downstream stream, REST upstream API, and shared adapter contract. Agent native sessions remain the source of truth for message history.
- Render only formal assistant response text with a controlled GFM renderer and syntax highlighting. Raw HTML is disabled. User text, thinking content, tool calls, tool arguments, and command output are rendered as plain text or structured diagnostic UI.
- Add client-only pending-turn state. It begins immediately after an accepted normal prompt and ends at the first displayable streamed event or terminal error; the visual is an animated assistant-side loading bubble and is never persisted as a message.
- Extend dashboard session metadata with a nullable selected model and a nullable latest error. Use a backward-compatible SQLite migration so existing installations preserve their sessions.
- Extend the shared adapter contract with agent-specific model discovery and model selection while retaining a common dashboard model-option representation. Query models from the current local agent environment. When discovery has no options, permit the agent's existing default model.
- Model selection happens before the corresponding agent turn. Persist the selected model only after the target adapter confirms the switch; if it rejects the change, preserve the prior stored selection and return an actionable error without sending the requested turn.
- Classify composer input before ordinary prompt dispatch: `/command` is a native agent command, `! command` is a direct user shell command, and other input is an ordinary agent prompt. Unsupported native commands fail explicitly and never fall back to normal prompt text.
- Native commands execute through each adapter's native command path and preserve that agent's existing permission broker. They may emit ordinary agent events and permissions over the existing SSE channel.
- Direct shell commands execute in the dashboard session's configured working directory as an explicit user-authorised action. They bypass the agent permission broker but are not injected into agent context. Their output is emitted and rendered as a dedicated command-result event/block with stdout, stderr, and exit status.
- A non-zero direct-shell exit status does not transition the dashboard session to `error` and does not update latest error metadata. Only an adapter or SDK failure during agent work does so. A successful subsequent agent turn clears the stored latest error.

## Testing Decisions

- Prefer the existing public REST plus multiplexed SSE server seam, using the established fake adapter and temporary SQLite database. Assert visible statuses, API results, SSE events, and persisted session metadata rather than adapter internals.
- Add migration and lifecycle coverage for the selected model and latest error: old databases remain usable, adapter/SDK failure records the latest error, a successful agent turn clears it, and shell exit failure does neither.
- Add adapter contract tests for each supported coding agent's available-model discovery, model selection, native command dispatch, permission behaviour, and direct-shell mapping where the native SDK supports it.
- Add client state tests for the pending-turn indicator's externally visible lifecycle: it begins at submission and ends on the first displayable event or terminal failure.
- Add component-level Markdown safety and rendering tests for common GFM blocks, highlighted code fences, and inert raw HTML. Verify only rendered behaviour, not renderer implementation details.
- Add server integration coverage that native commands preserve permission routing, unsupported commands fail clearly, direct shell commands use the dashboard session working directory, their output remains outside agent context, and non-zero exits leave the session available for further interaction.

## Out of Scope

- Styling or replacing the existing conversation scrollbar.
- Automatically injecting direct-shell output into future agent context.
- Treating `/command` as an implicit user authorisation that bypasses agent permissions.
- Inventing dashboard-only substitutes for native agent commands that an adapter cannot support.
- Interrupt/cancel controls, unified historical-session resume, visual file diffs, post-creation session renaming or labels, cross-agent handoff, and a desktop shell.

## Further Notes

- The selected model is dashboard session metadata, but native agents can have different persistence semantics; the adapter owns the mapping and exposes agent-specific availability details through the common contract.
- The direct `!` prefix is a narrowly scoped user-authorisation exception. It does not relax the approval policy for tool calls initiated by a coding agent or by a native `/command`.
- The existing UI defect concerning the conversation scrollbar is explicitly deferred.
