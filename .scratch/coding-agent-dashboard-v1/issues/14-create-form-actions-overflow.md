# 14 — Create-form actions overflow when the agent has many native sessions

**What to build:** When creating a session and the chosen directory + agent already has a large number of native sessions, the "Start from" resume list (`<fieldset class="resume-options">` in `client/src/components/CreateSessionForm.tsx`) grows without bound. The action bar (`<div class="create-form-actions">` — Cancel / Create session) gets pushed below the visible viewport and becomes unreachable — the buttons can't be seen or clicked.

**Blocked by:** #7 — Create-time resume of existing native sessions

**Status:** done

## Root cause

- `.resume-options` has **no** `max-height` / `overflow-y` constraint, so a long list of resumable sessions keeps growing the form. (By contrast, the file tree `.file-tree` is capped at `max-height: 240px; overflow-y: auto` — see `client/src/styles.css`.)
- The form is centered with `margin: auto` inside `.main`, which is `display: flex; overflow: hidden` (`styles.css` `.main`). When the form is taller than the viewport, it overflows the container and the overflow is clipped with **no scroll**, so the action bar lands outside the visible area and can't be reached.

## Fix

- [x] Cap `.resume-options` at a fixed height with internal scroll (`max-height: 240px; overflow-y: auto`, matching `.file-tree`), so a long list scrolls inside the fieldset and the form keeps a bounded height. (`min-height: 0` lets it shrink as a flex item.)
- [x] Fallback for short viewports: cap `.create-form` with `max-height: 100%; min-height: 0; overflow-y: auto` so the action bar stays reachable even when the whole form would otherwise exceed the window.

**Verified:** build + tests pass. Headless-Chrome layout check at 1280×800 — before: action bar `top=2170` (off-screen); after: `top=642`, visible; resume list scrolls internally; on a 500px-tall window the form scrolls so the actions stay reachable.
