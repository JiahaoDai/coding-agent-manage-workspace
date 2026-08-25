# Coding Agent Dashboard

[中文说明](./README_zh.md)

Coding Agent Dashboard is a local, single-user web UI for managing multiple coding-agent sessions and agent teams from one workspace. It currently supports Claude Code, OpenCode, and Pi through a shared adapter interface.

The app is designed for local development workflows where agents can stream responses, request permission before using tools, work in project directories, and collaborate as a leader-driven team.

## What It Does

- Create and resume coding-agent sessions by project directory.
- Chat with Claude Code, OpenCode, or Pi sessions with streamed text, thinking, status notes, tool calls, and Markdown rendering.
- Select agent models when the adapter supports model discovery.
- Use a split workspace with up to two independently active sessions.
- Review and answer tool permission requests from a global modal.
- Soft-delete dashboard session records without deleting the agent's native session history.
- Create agent teams with custom roles, shared cwd, leader planning, worker deliveries, review/fix loops, final answers, and user clarification prompts.
- Inspect team run activity, delivery streams, member status, persisted run history, and permission context.

## Architecture

```text
client/ React + Vite
  - UI, local workspace state, SSE consumer
  - session chat, split panes, team chat, permission modal

server/ Hono + Node
  - REST API and multiplexed SSE stream
  - adapter registry for Claude Code, OpenCode, Pi
  - permission broker
  - SQLite metadata store
  - file tree API for selecting cwd

shared/
  - TypeScript contracts shared by client and server
  - sessions, teams, events, adapter types
```

Runtime flow:

```text
Browser UI
  ├─ REST /api/... ───────────────► Node server
  ├─ SSE /api/events ◄──────────── Node server
  │
Node server
  ├─ SQLite metadata: sessions, teams, runs, messages, deliveries
  ├─ AgentAdapter: Claude/OpenCode/Pi SDK integration
  └─ Agent native stores: message bodies and native session history
```

The dashboard stores its own metadata in SQLite, but ordinary session message bodies are read from each agent's native store through the adapter. Team coordination metadata is stored in SQLite so team runs can be reloaded after refresh.

## Repository Layout

```text
client/
  index.html
  src/
    App.tsx                  main UI and SSE routing
    components/              session, team, permission UI
    conversation.ts          streamed chat state reducer
    workspace.ts             split-pane workspace state
    styles.css               application styles

server/
  index.ts                   server bootstrap
  app.ts                     REST routes, SSE events, team orchestration
  db.ts                      SQLite schema and store
  permission.ts              permission broker
  sse.ts                     SSE hub
  adapters/                  Claude/OpenCode/Pi adapter implementations
  fs/tree.ts                 safe file-tree browsing under FS_ROOT

shared/
  adapter.ts                 AgentAdapter contract
  events.ts                  SSE event contract
  session.ts                 session types
  team.ts                    team/run/delivery types

docs/
  design.md                  product and architecture design
  agent-team-prd.md          agent team PRD
  specs/                     versioned feature specs
```

## Requirements

- Node.js compatible with the installed dependencies.
- npm.
- Local credentials/configuration for whichever agents you want to use:
  - Claude Code
  - OpenCode
  - Pi coding agent

The dashboard does not provide agent credentials. It calls each adapter/SDK in the local environment.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the app in development:

```bash
npm run dev
```

This starts:

- API/SSE server on `http://localhost:4000`
- Vite client on `http://localhost:5173`

Open `http://localhost:5173` in your browser.

Build the client:

```bash
npm run build
```

Run checks:

```bash
npm run typecheck
npm test
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Node API/SSE server port. |
| `DB_PATH` | `data/sessions.db` | SQLite metadata database path. Use `:memory:` for tests/dev experiments. |
| `FS_ROOT` | user home directory | Root directory exposed by the in-app file tree. Paths outside this root are rejected. |
| `OPENCODE_MODEL` | `deepseek/deepseek-v4-flash` | Default model passed to the OpenCode adapter. |
| `OPENCODE_URL` | unset | Optional OpenCode server URL used by the OpenCode SDK integration. |
| `PI_MODEL` | unset | Optional Pi model override. If unset, Pi resolves its own default. |

Example:

```bash
FS_ROOT=/Users/me/github DB_PATH=data/dev.db OPENCODE_MODEL=deepseek/deepseek-v4-flash npm run dev
```

## Using Sessions

1. Click to create a new session.
2. Pick a project directory from the file tree.
3. Choose an agent.
4. Optionally resume an existing native session found for that directory/agent.
5. Name the dashboard session.
6. Send messages from the composer.

Session features:

- streamed assistant output
- Markdown/GFM rendering with code highlighting
- thinking/status/tool-call display
- model picker when supported by the adapter
- split workspace with independent active panes
- soft delete of dashboard metadata

## Using Agent Teams

Create a team by choosing:

- team name
- shared project directory (`cwd`)
- members with role, agent, model, and responsibility prompt

Team run flow:

1. You send a request to the team.
2. The leader receives the request first.
3. The leader returns a strict JSON plan, final result, or need-info request.
4. Planned assignments become deliveries to workers/reviewers.
5. Deliveries run globally sequentially in v1.
6. Worker results are routed back to the leader.
7. The leader can replan, request review/fix work, ask you for missing information, or produce a final answer.

Team UI areas:

- member roster with status and current delivery
- run activity timeline with Markdown-rendered messages
- delivery streams with streaming transcript and process events
- user clarification banner when the team is waiting for input
- permission modal scoped to the originating team/member/delivery

## Data Model

The SQLite store contains:

- `session`: dashboard metadata and mapping to native agent session ids
- `team`: team records
- `team_member`: team roles and backing dashboard sessions
- `team_run`: one user request and its collaboration lifecycle
- `team_message`: bus messages such as user request, assignment, result, review, need_info, final
- `team_message_delivery`: scheduled delivery instances
- `team_delivery_dependency`: delivery dependencies

Ordinary session message bodies remain in the agent-native store. Team message content is persisted because team orchestration needs to reload run history and delivery context.

## Extending Agents

To add another coding agent:

1. Implement `AgentAdapter` from [`shared/adapter.ts`](./shared/adapter.ts).
2. Add the implementation under `server/adapters/`.
3. Register it in [`server/index.ts`](./server/index.ts).
4. Add adapter tests for session creation, prompt streaming, permission handling, messages, model discovery, and error behavior.

The server only talks to agents through `AgentAdapter`, so UI and orchestration code should not need agent-specific branches.

## Development Notes

- REST and SSE endpoints live under `/api`.
- The Vite dev server proxies `/api` to `http://localhost:4000`.
- SSE is multiplexed: ordinary session events and team events use the same `/api/events` stream.
- Agent tool permissions are never silently accepted by the dashboard. Adapters surface permission requests through the shared prompt handlers.
- Some integration tests need normal local process/port access.

## Known Limits

- This is a local single-user tool, not a multi-user service.
- Team v1 runs deliveries globally sequentially to avoid concurrent edits in the same project directory.
- Team members are created with fresh sessions and are not shared across teams.
- Native agent behavior, authentication, available models, and message history depend on each agent SDK/CLI.
