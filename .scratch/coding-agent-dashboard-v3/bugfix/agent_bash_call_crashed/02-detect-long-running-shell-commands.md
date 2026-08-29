# Ticket 2: Detect Long-Running Shell Commands

> Status: ready
> Area: server, prompts
> Priority: medium

## Problem

Agents can accidentally run commands that start foreground servers, watchers, or other long-running processes. If the command never returns, the current delivery can stay running until timeout or manual cancellation.

Delivery timeout is the main safety net. This ticket reduces avoidable timeouts by warning about risky shell commands before they run.

## Goal

Classify long-running-looking shell commands in the team tool policy and make the permission UI communicate the risk.

Do not auto-rewrite commands in the first version.

## Command Classification

Add a conservative category:

```ts
type ToolAction =
  | 'read'
  | 'write'
  | 'shell_read'
  | 'shell_write'
  | 'shell_long_running'
  | 'shell_git_merge'
  | 'shell_git_apply'
  | 'shell_unknown';
```

Candidate long-running patterns:

```text
npm run dev
npm start
pnpm dev
pnpm start
yarn dev
yarn start
vite
tsx watch
nodemon
node server.js
node index.js
python -m http.server
rails server
go run
cargo watch
webpack --watch
jest --watch
vitest --watch
```

Also consider commands that combine likely server startup with pipes, for example:

```bash
node index.js | head -5
```

The classifier should be conservative. If unsure, return `shell_unknown` and ask user confirmation through the existing flow.

## Policy Behavior

For readonly members:

- Deny long-running shell commands, because they are operational side effects.

For read-write members:

- Ask for user confirmation.
- Show a warning that the command may keep the delivery running.
- Recommend using `timeout`, background process cleanup, or a dedicated test command.

For leader in original cwd:

- Do not hardcode special role permissions beyond the current project rule.
- Still show long-running warning when a matching command appears.

## Prompt Guidance

Add a short instruction to team member initialization or delivery prompt:

```text
When starting servers, watchers, or long-running commands for verification, always run them with a timeout or in the background with a cleanup step. Do not leave foreground processes running. Prefer test commands that exit on their own.
```

For read-write worktree members, keep the existing worktree boundary instruction:

```text
Only modify files inside your execution cwd.
```

## Permission UI

When a command is classified as `shell_long_running`, the modal should show a concise risk note:

```text
This command may start a long-running process and keep the delivery running. Prefer a timeout or explicit cleanup.
```

The user can still allow it. The policy should not block legitimate server verification workflows for editable agents.

## Acceptance Criteria

- Long-running-looking commands are classified separately from ordinary shell writes.
- Readonly members cannot run long-running shell commands.
- Read-write members require confirmation with a clear warning.
- Prompt text tells members to use timeout/background cleanup for servers and watchers.
- Existing read/write/git policy behavior remains unchanged.

## Tests

Add tests for:

- `npm run dev` is classified as `shell_long_running`.
- `node index.js` is classified as `shell_long_running`.
- `node index.js | head -5` is classified as long-running or unknown, not read-like.
- Readonly member gets denied for long-running command.
- Read-write member gets an ask decision with warning metadata if the policy supports notes.
- Prompt builder includes long-running command guidance.

## Non-Goals

- Do not automatically rewrite commands to add `timeout`.
- Do not implement delivery timeout here.
- Do not implement process-tree killing here.
- Do not make command parsing perfect; regex-based classification is enough for the first version.

