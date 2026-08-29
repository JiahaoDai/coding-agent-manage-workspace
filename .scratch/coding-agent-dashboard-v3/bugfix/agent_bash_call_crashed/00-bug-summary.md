# Agent Bash Tool Call Stuck Bug Summary

> Status: draft
> Date: 2026-08-29
> Scope: Agent Team delivery lifecycle when an agent tool call never returns.

## Background

Agent Team delivery execution waits for the selected member session to finish one agent turn:

```ts
await adapter.prompt(...)
```

Only after that promise resolves or rejects can the orchestrator finish the delivery attempt and update delivery/member/session state.

If the agent starts a tool call that never returns, the delivery runner also never returns. This leaves the team run blocked even though the root cause is only one command inside one member session.

## Observed Case

Team:

```text
team_id = 2115aac0-a33d-46d3-a995-80247c0a6f75
```

Blocked delivery:

```text
delivery_id = 1fcb05fc-0594-4cf9-b3a6-c3e864f7b631
member = backend-coder
```

Observed state:

```text
team.status = running
team_message_delivery.status = running
team_delivery_attempt.status = running
team_member.status = running
session.status = running
```

The Pi native transcript did not end with a normal `RESULT` or `FAILED`. It ended inside a `bash` tool call.

Problem command shape:

```bash
cd .../backend-coder/server && node -e "
const pkgRoot = require('path').dirname(require.resolve('node-pty/package.json'));
console.log('pkgRoot:', pkgRoot);
require('./index.js');
console.log('index.js loaded OK');
" 2>&1 | head -5
```

`require('./index.js')` starts the backend server. The Node process stays alive. Because the command also pipes to `head -5`, the shell can remain waiting if there are not enough output lines or if the process does not close cleanly.

## Root Cause

The current delivery lifecycle has no hard boundary around agent turn duration or tool call duration.

Failure chain:

```text
orchestrator starts delivery
  -> delivery attempt marked running
  -> member/session marked running
  -> adapter.prompt(...) begins
  -> agent asks to run bash
  -> user allows bash
  -> bash command starts a foreground long-running process
  -> tool call never returns
  -> adapter.prompt(...) never resolves or rejects
  -> finishTeamDeliveryAttempt(...) never runs
  -> delivery remains running forever
```

This is not only a Pi issue. Any adapter can get stuck if the underlying coding agent starts a command that does not terminate and the adapter does not surface a terminal event.

## Why Prompt Guidance Is Not Enough

Prompting members to avoid foreground servers helps, but it is not a reliable safety boundary.

Agents can still run:

- `npm run dev`
- `npm start`
- `vite`
- `tsx watch`
- `node index.js`
- `python -m http.server`
- long-running test watchers
- scripts that block on a server process

The orchestrator must be able to time out, cancel, fail, or retry a delivery independently of the agent's cooperation.

## Desired Direction

Split the fix into two tickets:

1. Add delivery timeout, adapter abort, and manual cancel/retry recovery.
2. Detect long-running-looking shell commands and warn or require safer command shape.

The first ticket is the real safety net. The second ticket reduces how often the safety net is needed.

