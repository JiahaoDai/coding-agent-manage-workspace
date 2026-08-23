## Problem Statement

The coding-agent dashboard can manage many local coding-agent sessions, but the main workspace only lets a developer view and type into one session at a time. This makes parallel work awkward: the developer has to switch back and forth between sessions to compare output, monitor progress, or send follow-up prompts. They want a VS Code-like split workspace where two sessions can be visible side by side, each with its own composer, streamed output, status, and controls.

## Solution

Add a split workspace to the local dashboard. The main area can show up to two session panels at once. A session can be opened normally into the active panel or opened in split from the session list's right-click menu. Each panel renders the existing conversation experience independently: message history, streaming updates, pending feedback, tool and thinking blocks, model selection, composer input, and status. A draggable divider lets the developer adjust the panel ratio. Each panel has a close button. The dashboard preserves the split layout as browser-local UI state, while session metadata and message history remain governed by the existing SQLite and native-agent storage model.

## User Stories

1. As a developer, I want to view two coding-agent sessions side by side, so that I can monitor parallel work without switching views.
2. As a developer, I want each visible session to have its own input box, so that I can prepare and send prompts independently.
3. As a developer, I want both visible sessions to stream output at the same time, so that concurrent agent work remains observable.
4. As a developer, I want each session panel to show its own session name, agent, directory, and status, so that I can tell which work I am looking at.
5. As a developer, I want each session panel to show its own pending response indicator, so that I know which session is waiting for the first streamed event.
6. As a developer, I want each session panel to retain the existing Markdown assistant rendering, so that split mode does not degrade message readability.
7. As a developer, I want each session panel to retain tool-call and thinking displays, so that diagnostic information remains available in split mode.
8. As a developer, I want each session panel to retain model selection, so that I can choose models independently per session.
9. As a developer, I want a right-click menu on a session list item, so that split-opening is available without adding noisy hover controls.
10. As a developer, I want the right-click menu to offer Open, so that I can open a session in the currently active panel.
11. As a developer, I want the right-click menu to offer Open in Split, so that I can open a session beside the currently active panel.
12. As a developer, I want the right-click menu to exclude Delete, so that destructive actions continue to use the existing explicit delete control.
13. As a developer, I want Open to replace the active panel's session, so that the default open action is predictable.
14. As a developer, I want Open in Split to create a second panel when only one panel is open, so that I can move from single-session work to split work quickly.
15. As a developer, I want Open in Split to replace the non-active panel when two panels are open, so that I can intentionally keep my active panel in place.
16. As a developer, I want a session that is already open to become active rather than being duplicated, so that I never have two composers writing to the same session.
17. As a developer, I want to click inside a panel to make it active, so that follow-up open actions target the panel I am working in.
18. As a developer, I want the active panel to be visually indicated, so that I can see where normal Open actions will land.
19. As a developer, I want the selected session in the sidebar to reflect the active panel's session, so that the list and workspace stay oriented around the same focus.
20. As a developer, I want to drag the divider between panels, so that I can give more space to the session that currently needs attention.
21. As a developer, I want the divider to avoid adding page-level horizontal scrolling, so that the workspace remains contained in the main area.
22. As a developer, I want normal text to wrap within each panel, so that narrow panels remain readable without page-level horizontal scrolling.
23. As a developer, I want code blocks and JSON/tool arguments to keep their own internal horizontal scroll when necessary, so that indentation and command output remain readable.
24. As a developer, I want the composer layout to adapt in narrow panels, so that typing and sending remains possible even when space is tight.
25. As a developer, I want each panel's messages to scroll independently, so that reading one session does not move the other session.
26. As a developer, I want each panel to have a close button, so that I can dismiss one side like a VS Code split editor group.
27. As a developer, I want closing one of two panels to make the remaining panel fill the main workspace, so that I can return to single-session work cleanly.
28. As a developer, I want closing the last panel to show the existing empty state, so that there is an obvious way to start or select work again.
29. As a developer, I want unsent draft text to be retained by session when a panel is closed and reopened, so that accidental panel closure does not lose my prompt.
30. As a developer, I want a newly created session to open into the active panel, so that creation follows the same targeting rule as Open.
31. As a developer, I want the split layout to survive a page refresh, so that my workspace arrangement is not lost during routine reloads.
32. As a developer, I want invalid restored panel references to be cleaned up, so that deleted or missing sessions do not leave broken panels.
33. As a developer, I want permission requests to keep using a global modal, so that approval prompts are never hidden inside a narrow or scrolled panel.
34. As a developer, I want permission requests to identify the source session clearly, so that I can make safe allow/deny decisions while two sessions are visible.
35. As a developer, I want the panel that owns a permission request to be lightly highlighted when it is visible, so that I can locate the request's source quickly.
36. As a developer, I want permission requests from sessions that are not currently visible to still be actionable, so that background sessions do not deadlock.
37. As a developer, I want two running sessions to remain isolated in the UI, so that one session's stream, pending state, model, permission request, or error does not affect the other.
38. As a developer, I want the split workspace to preserve the existing single-session behavior when only one panel is open, so that the feature does not make the default workflow heavier.
39. As a developer, I want keyboard dismissal and outside-click dismissal for the context menu, so that the menu behaves like a normal desktop UI.
40. As a developer, I want the context menu to stay within the viewport, so that right-clicking near an edge does not make menu actions unreachable.

## Implementation Decisions

- The feature is a client-side workspace enhancement. It does not change the server adapter contract, SQLite session schema, native agent storage model, REST message API, or multiplexed SSE protocol.
- Replace the single selected-session workspace model with a panel workspace model: up to two panels, each associated with one dashboard session id, plus an active panel identifier and a split ratio.
- Keep one active panel. Clicking a panel makes it active. The sidebar's selected session is the active panel's session. If there are no panels, there is no selected session.
- Keep duplicate session prevention as an invariant. A dashboard session id may appear in at most one panel. Opening an already visible session activates its existing panel instead of creating another view.
- Define Open as "open the target session in the active panel." If no panel exists, Open creates one panel. If the target session is already open, Open only activates that panel.
- Define Open in Split as "open the target session in the non-active panel." If only one panel exists, it creates a second panel. If two panels exist, it replaces the non-active panel. If the target session is already open, it only activates that panel.
- Add a context menu to session list items. The menu is opened by right-clicking a session list item and contains only Open and Open in Split. Existing delete behavior stays on the existing delete control.
- The context menu closes when the user selects an action, clicks outside it, presses Escape, or opens a different context menu. The menu is positioned so that it remains inside the viewport.
- Add a close control to each panel header. Closing one of two panels leaves the other panel open and active. Closing the final panel returns the main workspace to the existing empty state.
- Newly created sessions open into the active panel. If there is no active panel, creation creates a single panel containing the new session.
- Keep each conversation panel's composer, local draft, selected model display, pending indicator, history load state, message stream, and scroll container scoped to that panel's session.
- Preserve unsent draft text by session rather than by mounted panel instance, so closing and reopening a session can restore the draft without prompting the user.
- Load native message history and available models for every session opened in a panel, not only for a single selected session. Existing once-per-session history loading semantics remain appropriate.
- Continue routing SSE events by dashboard session id. The split workspace reads from the same per-session conversation, status, pending, and permission state maps already used by the single-session view.
- Persist only browser-local workspace layout state in localStorage: open panel session ids, active panel, and split ratio. Do not persist this layout in SQLite because it is a UI preference, not dashboard session metadata.
- When restoring localStorage, discard panel entries whose sessions no longer exist. If the active panel is invalid, choose an existing restored panel as active; if none remain, show the empty state.
- Add a draggable vertical divider between two panels. Dragging changes the split ratio. No explicit reset control is required.
- Avoid page-level horizontal scrolling in split mode. Panels shrink within the main workspace. Normal text wraps inside each panel.
- Preserve block-level internal horizontal scrolling for code blocks, command output, and JSON/tool arguments, because wrapping these structures can destroy indentation and readability.
- Use a weak panel minimum width. At normal desktop widths, preserve enough room for useful reading and composing; at very narrow widths, allow panels to continue shrinking rather than forcing a page-level horizontal scrollbar.
- Let composer controls adapt in narrow panels. Model labels may truncate or wrap as needed, while the send button remains a stable icon-sized control.
- Keep permission approval as a global modal. The modal must identify the source session by name and agent, and may include the working directory when needed for safety. If the source session is visible in a panel, that panel receives a light highlight while the request is pending.
- The feature should follow the existing ChatGPT-inspired restrained UI style: compact panels, subtle active state, familiar icon controls, and no large explanatory copy inside the app.

## Testing Decisions

- Prefer one high-level client workspace seam: render the app/workspace with scripted session data and fake API/SSE interactions, then assert visible behavior from the user's perspective. This is the highest useful seam because the feature is primarily a coordination layer across existing session list, conversation view, permission modal, and layout state.
- Test external behavior rather than implementation details. Assert which session panels are visible, which panel is active, where Open and Open in Split place sessions, whether duplicate opens activate instead of duplicating, and how close controls affect the visible workspace.
- Add component coverage for the session-list context menu. Verify right-click opens the menu, Open and Open in Split invoke the correct user-visible actions, Delete is not present in the menu, Escape/outside click closes it, and viewport-edge placement keeps actions reachable.
- Add workspace layout coverage for divider behavior. Verify drag updates the panel ratio and that both panels remain visible without page-level horizontal overflow.
- Add responsive/rendering coverage for narrow panels. Verify ordinary assistant text wraps, code/tool blocks preserve internal horizontal scrolling, composer controls remain usable, and panel-level message scrolling stays independent.
- Add persistence coverage around browser-local layout state. Verify open panels, active panel, and split ratio restore after reload; invalid session ids are discarded; and the empty state appears when no valid panel remains.
- Add draft preservation coverage. Verify unsent text can survive closing and reopening a session panel without being sent or written to native history.
- Add permission coverage in split mode. Verify a permission request shows the global modal with source session identity, highlights the owning panel when visible, and remains actionable when the source session is not currently open in a panel.
- Reuse existing prior art from the codebase: component rendering tests for conversation UI behavior, pure conversation-state tests for message mapping and displayability, and server/SSE tests only where existing events need to be proven unchanged. Since the server contract does not change, new server tests should be minimal.

## Out of Scope

- More than two simultaneous panels.
- Dragging tabs or sessions between arbitrary panel groups.
- Nested split layouts, vertical split orientation, or multi-row workspaces.
- Page-level horizontal scrolling for split mode.
- A reset-to-50/50 divider control.
- Adding Delete to the right-click context menu.
- Allowing the same session to appear in both panels at once.
- Persisting panel layout in SQLite or syncing it across browsers.
- Changing agent adapter behavior, native session storage, REST routes, SSE event shapes, or the SQLite session schema.
- Replacing the global permission modal with fully in-panel permission prompts.
- Confirming before closing a panel with an unsent draft.
- Implementing interrupt/cancel controls, unified historical-session resume, visual file diffs, post-creation session renaming or labels, cross-agent handoff, or a desktop shell.

## Further Notes

- This spec is based on the v3 split-workspace discussion and the updated design document's split workspace section.
- The important product constraint is that split mode should feel like a lightweight VS Code-style workspace, not a new multi-window application.
- The important safety constraint is that permission approval remains unmistakably tied to the source session even when two sessions are visible.
- The important layout constraint is that the main page should not gain a horizontal scrollbar; ordinary text wraps, while code-like blocks keep their own internal scroll.
