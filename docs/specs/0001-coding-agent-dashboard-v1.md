## Problem Statement

A developer runs several local coding agents — Claude Code, OpenCode, and Pi — each with its own CLI, session storage, and streaming output. To work across them they have to juggle multiple terminals and remember where each conversation lives. They want a single local interface where they can create sessions, hold multi-turn conversations with any of the agents (in parallel, with streaming output and visible tool calls), and — because the agents can actually run commands and edit files — approve or deny each dangerous action from the UI. The interface must not duplicate the agents' native message storage.

## Solution

A local, single-user web app: a React + Vite client (pure presentation) talking to a Node server (the sole caller of the agent SDKs, SQLite, and the filesystem) over SSE (downstream, a single multiplexed stream) and REST POST (upstream). Each agent is driven headlessly through its official SDK behind one common **adapter interface**; adding a new agent means adding one adapter. The server persists only session metadata (its own session id, the agent, the agent's real session id, a display name, the working directory, status, and timestamps) in SQLite — message bodies are always read from the agent's native store. Agent actions that touch the system surface in the UI as permission requests the user allows or denies.

## User Stories

1. As a developer, I want to create a new session by selecting a project directory, so that the agent runs in the correct working directory.
2. As a developer, I want to choose which coding agent (Claude Code, OpenCode, or Pi) a session uses, so that I can pick the right agent for the task.
3. As a developer, I want to give a session a display name, so that I can tell sessions apart in the list.
4. As a developer, I want the app to detect any existing native sessions for the chosen directory and agent, so that I can pick up prior work instead of always starting fresh.
5. As a developer, I want to choose between resuming an existing native session and starting a new one, so that I don't lose prior conversation context.
6. As a developer, I want the resume flow to prefill the display name from the native session's summary or first prompt, so that I can edit it rather than retype it.
7. As a developer, I want to send a message in a session and receive a streamed reply, so that I can converse with the agent in real time.
8. As a developer, I want to see incremental text output as the agent responds, so that I can follow progress without waiting for the whole turn to finish.
9. As a developer, I want to see the tool calls the agent makes (commands, file reads, file writes) along with their arguments, so that I understand what the agent is doing.
10. As a developer, I want tool calls shown collapsed by default, so that verbose tool output doesn't clutter the conversation.
11. As a developer, I want to see the agent's thinking process, so that I can understand its reasoning.
12. As a developer, I want thinking output collapsed by default, so that it stays out of the way when I don't need it.
13. As a developer, I want a session to return to an idle/completed state once a turn finishes, so that I know it is ready for the next message.
14. As a developer, I want to run multiple sessions concurrently, possibly across different agents, so that I can work on several tasks in parallel.
15. As a developer, I want each running session's status to be visible in real time, so that I can see at a glance what is active, finished, or failed.
16. As a developer, I want the session list grouped or filterable by agent, so that I can find the sessions for a particular agent.
17. As a developer, I want to filter sessions by status, so that I can focus on running or completed sessions.
18. As a developer, I want to search sessions by keyword, so that I can locate a specific session by name or directory.
19. As a developer, I want each session in the list to show a status badge (running / completed / error / cancelled), so that I can assess its state quickly.
20. As a developer, I want the list to show a session's directory and last-modified time, so that I can orient myself across many sessions.
21. As a developer, I want to soft-delete a session so that it disappears from my interface without destroying the agent's native session.
22. As a developer, I want deleted sessions to be re-importable from the agent's native store, so that a soft delete is recoverable.
23. As a developer, I want the agent's tool actions — running commands and editing files — to require my confirmation, so that dangerous operations never happen silently.
24. As a developer, I want a permission request to show me which tool is being invoked and its arguments, so that I can make an informed allow/deny decision.
25. As a developer, I want to allow or deny a permission request from the UI, so that I remain in control of the agent's actions.
26. As a developer, I want the agent to proceed when I allow and to be told it was denied when I deny, so that the approval loop is actually enforced.
27. As a developer, I want permission requests from concurrently running sessions to each route to their own window, so that approvals never get mixed up.
28. As a developer, I want to select a project directory from an in-app file tree, so that I don't have to type absolute paths.
29. As a developer, I want the file tree rooted at a configurable directory (defaulting to my home directory), so that the app doesn't crawl the entire filesystem.
30. As a developer, I want the app to be local and single-user, so that I don't need accounts or a hosted server.
31. As a developer, I want the UI to recover its session list and state after a page refresh or a dropped connection, so that a transient disconnect doesn't lose my view.
32. As a developer, I want message history to be read from the agent's native store at display time, so that the app never stores duplicate message bodies.

## Implementation Decisions

- **Three-module package**: a single repository split into `client` (React + Vite + TypeScript), `server` (Node + TypeScript), and `shared` (the type contracts and the adapter interface used by both). This is a local tool, so a monorepo tool is deliberately avoided.
- **Adapter interface is the single seam.** Every agent is wrapped by one adapter implementing a common interface; `shared` defines that interface. The interface must expose, at minimum: creating/opening a session for a working directory; listing native sessions for a directory; reading a session's messages; streaming a prompt's events; and registering a permission hook. The exact method signatures are the implementation's first deliverable and are agreed in `shared` before any agent adapter is written.
- **Agents and SDKs**: Claude Code via `@anthropic-ai/claude-agent-sdk`, OpenCode via `@opencode-ai/sdk`, Pi via `@earendil-works/pi-coding-agent`. Each adapter is the only place agent-specific behaviour lives.
- **The server is the single authority.** It is the only caller of the agent SDKs, the only reader/writer of SQLite, and the only accessor of the filesystem (for the file tree). The client never touches any of these directly.
- **Metadata-only storage.** SQLite holds one `session` table: `session_id` (UUID, primary key — the app's own id), `coding_agent`, `real_session_id` (the agent's native session id), `name`, `cwd` (absolute path), `status`, `create_time`, `modify_time`. Message bodies are never written to SQLite; they are read from the agent's native store using `real_session_id`. An index on `(coding_agent, status, cwd)` supports filtering, status grouping, and search.
- **Session status values**: `running`, `completed`, `error`, `cancelled`. The adapter listens to the agent's lifecycle events and drives these transitions in real time.
- **Soft delete is a physical row delete.** Deleting removes the SQLite row and leaves the agent's native session intact, so the session can be re-imported later. No separate "deleted" status exists.
- **Concurrency via isolated subprocesses.** Each running session is an independent headless subprocess, which is what makes parallel sessions and independent streaming natural.
- **Communication protocol.** Downstream (server → client) is a single multiplexed SSE stream; every event carries a `session_id` and the client routes it to the right window. Upstream (client → server) is REST POST for sending messages, answering permissions, and creating/listing/deleting sessions. Event types are defined once in `shared` and include at least: session created, text delta, tool-call start/end (name + arguments), thinking delta, status change, permission request, permission response, session removed, and error. `EventSource` auto-reconnect is relied on; on reconnect/refresh the client re-reads SQLite (the single source of truth) and re-subscribes.
- **Interactive permission confirmation.** The server starts agents in `permissionMode: 'default'` and never uses `bypassPermissions`/`acceptEdits`. For Claude Code the hook is `canUseTool`, which has been verified and also surfaces `AskUserQuestion` clarifications. The request (tool name + input) is pushed to the client over SSE, the user's allow/deny comes back over REST POST, and the hook returns the corresponding allow/deny. OpenCode's `permission` event and Pi's approval flow exist but their exact approve/deny response shapes are unverified — they must be confirmed against each SDK before those adapters claim permission support. For any agent that cannot support real-time permission, the fallback is a per-agent fixed permission mode.
- **File tree for directory selection.** The server reads the filesystem and serves a tree rooted at a configurable directory (default the user's home directory), which keeps the browser from ever needing a raw absolute path and prevents whole-disk traversal.
- **Creation flow.** Select directory → select agent → the server checks that agent's native store for existing sessions in that directory and, if any, offers "resume existing" vs "start new" → name the session (prefilled when resuming) → the server creates/opens the session, writes a `session` row, and returns it to the client.

## Testing Decisions

- **One seam: the adapter interface.** Tests never spawn a real agent. They inject a fake adapter — an in-process implementation of the `shared` adapter interface that emits scripted events and records the calls it receives — and drive the server through its public REST + SSE surface against a temporary SQLite database.
- **What makes a good test.** Assert only externally observable behaviour: the events streamed over SSE, the status transitions a client would see, the contents and filtering of the session list, the round-trip of a permission request through allow/deny, and that a delete removes the app's record but never calls into the adapter to delete the native session. Never assert on internal wiring, method counts, or which code path produced a result.
- **Modules under test.** The server's session lifecycle (create/resume/name/delete), its SSE fan-out (events tagged correctly by `session_id`), the permission round-trip, concurrent-session isolation, and the list/filter/search behaviour. The adapter interface contract in `shared` is the boundary the fake adapter must satisfy.
- **Prior art.** None — this is a greenfield repository, so these tests establish the pattern for the codebase. The fake adapter will be the reusable fixture that every future server feature tests against.

## Out of Scope

- Interrupting/cancelling a running agent (a unified cancel entry point) — deferred to v2.
- A unified "resume/continue historical session" entry point beyond the create-time resume flow — deferred to v2.
- Visual file-diff rendering of the agent's edits — deferred to v2.
- Session renaming and custom labels after creation — deferred to v2.
- Cross-agent handoff (migrating conversation context between agents) — deferred to v2.
- A desktop shell (Tauri) for native directory selection and a system tray — deferred to v2.
- Verifying and hardening OpenCode's and Pi's permission approve/deny response shapes — these are a prerequisite for their adapters but are not part of this spec's build; they are flagged for the implementing agent to confirm.

## Further Notes

- The source of truth for this feature is the design document, which contains the full architecture, data model, decision log, and lifecycle flows this spec condenses.
- Open questions the implementing agent should resolve or flag: the package/app directory name; whether deleting a *running* session also terminates its backend subprocess; the default file-tree root and how it is configured; and the source used to prefill a resume session's name.
- The app is single-user and local by design; there is no authentication, multi-tenancy, or remote hosting.
