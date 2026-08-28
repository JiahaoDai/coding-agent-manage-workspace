# Agent Team Parallel Worktree Plan

> Status: draft
> Date: 2026-08-28
> Scope: Agent Team readonly/read-write policy, editable-member worktrees, and later parallel merge flow.

## 1. Background

The current Agent Team implementation uses `same cwd + global sequential delivery`.

All team members currently run in the selected project directory, and the scheduler only runs one delivery at a time for the whole team run. This keeps the first version simple and avoids most concurrent file modification conflicts.

The next step should be smaller than a full merge orchestration system: first distinguish readonly members from members that may edit files. Editable members will run in isolated git worktrees; readonly members can continue to use the original project cwd.

## 2. Current First Target

The first implementation should focus on two access modes:

```ts
type TeamMemberFileAccess = 'read_only' | 'read_write';
```

- `read_only`: the member can inspect the project and produce plans, reviews, analysis, or suggestions. It should not edit, create, delete, rename, format, install dependencies, commit, or merge.
- `read_write`: the member can inspect and edit files, but only inside its assigned execution cwd. In worktree isolation mode this cwd is the member's own worktree.

This first target does not need a generic capability system such as `plan/review/edit/merge/apply`, and it does not need a separate `team_worktree` table yet.

## 3. Goals

- Add a user-facing readonly/read-write choice for each team member.
- Extend the current `TeamMemberRecord` with file access and execution cwd fields.
- Extend member initialization prompts with the member's access mode and workspace boundary.
- Add server-side tool policy checks before normal permission confirmation.
- Create git worktrees for read-write members when worktree isolation is enabled.
- Keep all execution inside the existing team message bus and delivery model.

## 4. Non-Goals For The First Target

- Do not add a built-in `integrator` member.
- Do not add a generic capability matrix yet.
- Do not add `TeamWorktreeRecord` yet.
- Do not rely only on prompt text to enforce readonly behavior.
- Do not allow same-cwd parallel write execution by default.
- Do not automatically merge final results into the user's branch without user confirmation.

## 5. Data Model

The design should be described as additions to the current project type in `shared/team.ts`, not as a replacement record.

Current `TeamMemberRecord`:

```ts
export interface TeamMemberRecord {
  member_id: string;
  team_id: string;
  role: string;
  coding_agent: AgentId;
  session_id: string;
  model: string | null;
  responsibility_prompt: string;
  status: TeamMemberStatus;
  current_delivery_id: string | null;
  initialized_at: number | null;
  session_missing?: boolean;
  create_time: number;
  modify_time: number;
}
```

Recommended additions:

```ts
export interface TeamMemberRecord {
  member_id: string;
  team_id: string;
  role: string;
  coding_agent: AgentId;
  session_id: string;
  model: string | null;
  responsibility_prompt: string;
  status: TeamMemberStatus;
  current_delivery_id: string | null;
  initialized_at: number | null;
  session_missing?: boolean;

  /** read_only members may inspect but must not modify project files. */
  file_access: 'read_only' | 'read_write';
  /** The cwd used when prompting this member's backing agent session. */
  execution_cwd: string;
  /** Present only when this member runs in an isolated worktree. */
  worktree_path: string | null;
  /** Present only when this member runs in an isolated worktree branch. */
  worktree_branch: string | null;

  create_time: number;
  modify_time: number;
}
```

`TeamMemberInput` should also gain `file_access`:

```ts
export interface TeamMemberInput {
  role: string;
  agent: AgentId;
  model: string | null;
  responsibility_prompt: string;
  file_access: 'read_only' | 'read_write';
}
```

First-version defaults:

- Existing teams without this field should migrate to `read_write` or use a conservative app-level default chosen during migration.
- New reviewer/tester templates should default to `read_only`.
- New coder templates should default to `read_write`.
- The leader template can default to `read_only` for planning, but this is a template default, not a separate capability system.

## 6. Session And Worktree Lifecycle

Current team member sessions are created when the team is created, and each session is bound to its cwd. Worktree isolation must respect that.

### 6.1 Readonly Members

Readonly members keep the original project cwd:

```text
session.cwd = team.cwd
execution_cwd = team.cwd
worktree_path = null
worktree_branch = null
```

The directory is physically writable by the process, so readonly behavior must be enforced by prompt guidance plus server-side tool policy.

### 6.2 Read-Write Members

Read-write members need their worktree before their backing session is created:

```text
create team
  -> for read_only members, create session in team.cwd
  -> for read_write members, create member worktree
  -> create read_write member session in that worktree cwd
```

This keeps the current `team_member.session_id` assumption intact and avoids a larger lazy-session migration.

Recommended branch naming:

```text
agent-team/<team_id>/<member_role>
```

Recommended worktree path:

```text
<repo-parent>/.agent-team-worktrees/<team_id>/<member_role>
```

The server should derive and normalize the path. Agents should not choose arbitrary worktree paths.

## 7. Prompt Changes

The current project already builds a member initialization prompt in `memberInitializationPrompt(...)`. This plan should extend that prompt instead of replacing it.

Current shape:

```text
You are <role> in an agent team.

Your role:
<responsibility_prompt>

Collaboration rules:
- You receive tasks from the team orchestrator.
- Treat each incoming delivery as the next task in this same team session.
- Do not assume a previous task should be repeated unless the new delivery says so.
- Report results concisely for the leader.

Output format:
- RESULT: ...
- NEED_INFO: ...
- MESSAGE_TO reviewer: ...
- PROPOSAL: ...
- FAILED: ...
```

Add a workspace policy block:

```text
Workspace policy:
- File access: <read_only | read_write>
- Team root cwd: <team.cwd>
- Your execution cwd: <member.execution_cwd>
- Do not operate on files outside your execution cwd.
```

For `read_only` members, add:

```text
You are read-only for this team.
You may inspect files and report findings.
Do not edit, create, delete, rename, format, install dependencies, commit, merge, or run commands that modify files.
If the delivery requires file changes, respond with NEED_INFO or PROPOSAL instead of attempting edits.
```

For `read_write` members, add:

```text
You may edit files for this team.
Only edit files inside your execution cwd.
When worktree_path is present, your execution cwd is your isolated worktree.
Do not modify the original team root cwd from this session.
Report touched files and test results in RESULT.
```

Delivery prompts should also include the same execution cwd reminder:

```text
Workspace:
- File access: <read_only | read_write>
- Execution cwd: <member.execution_cwd>
- Only operate inside the execution cwd.
```

This makes the policy visible to the agent every time it receives work, while the real enforcement still lives in server-side tool policy.

## 8. Tool Policy

The server should evaluate every team permission request before it reaches ordinary user confirmation.

Pipeline:

```text
agent tool request
  -> normalize tool name and input
  -> classify action
  -> check member file_access
  -> check path boundaries when paths are available
  -> allow, deny, or ask user
```

### 8.1 Tool Classification

Suggested categories:

```ts
type ToolAction =
  | 'read'
  | 'write'
  | 'shell_read'
  | 'shell_write'
  | 'shell_git'
  | 'shell_unknown';
```

Structured tools:

- Read-like tools: `Read`, `Grep`, `Glob`, `LS`, `list`.
- Write-like tools: `Write`, `Edit`, `MultiEdit`, `Patch`, `edit`, `write`.

Shell commands should use conservative regex classification.

Clearly write-like shell patterns:

```text
>, >>, tee, rm, mv, cp, touch, mkdir, chmod, chown,
sed -i, perl -pi, npm install, pnpm install, yarn add
```

Git commands that can alter repository state:

```text
git add, git commit, git merge, git rebase, git checkout,
git switch, git reset, git clean, git worktree, git branch -d
```

Clearly read-like shell patterns:

```text
pwd, ls, cat, sed -n, grep, rg, find,
git status, git diff, git log, git show, git branch
```

Unclear commands should go to user confirmation. `npm test` should be treated as unclear in the first version because it can write snapshots, coverage, or caches.

### 8.2 Readonly Policy

Readonly members:

- Allow or ask for read-like tools according to the existing app policy.
- Automatically deny write-like structured tools.
- Automatically deny clearly write-like shell commands.
- Automatically deny git commands that alter repository state.
- Ask the user for unclear shell commands.
- Return a clear denial reason to the agent, for example: `Denied: this team member is read_only.`

### 8.3 Read-Write Policy

Read-write members:

- May write only under `execution_cwd`.
- Must not write to `team.cwd` when `execution_cwd` is a worktree.
- Must not use absolute paths outside `execution_cwd`.
- Must not use `..` path traversal to leave `execution_cwd`.
- Should ask the user for unclear shell commands.
- Should ask the user for package install, git state changes, or other high-risk commands.

For structured tools with paths, normalize the path against `execution_cwd` and deny the request if the result is outside that directory.

For shell commands, regex classification is intentionally conservative. It is a safety filter and user-confirmation helper, not a perfect shell parser.

## 9. Leader And Merge In The First Version

For the first read-only/read-write version, do not introduce a separate integrator role and do not introduce generic merge capabilities.

The existing Agent Team product model is leader-driven. In that model, the leader receives worker results and decides how to proceed. Unless the product later lets the user designate another member for root-cwd git work, the leader is the only member expected to handle git operations in the original project cwd.

First merge direction:

```text
1. Read-write workers finish changes in their own worktrees.
2. Workers report branch names, touched files, and test results to leader.
3. Leader decides merge order and reports the plan.
4. Leader runs ordinary merge-plan and status-inspection steps through the normal permission flow.
5. Conflicts are reported back to the team message bus and UI.
6. User confirmation is required only for conflict decisions, explicit need-info pauses, and final apply/merge into the user's cwd branch.
```

Important boundaries:

- This is a leader-driven product convention for the first version, not a generic capability framework.
- Non-leader readonly/review members should not receive cwd-changing git tasks.
- Read-write worker members should not merge into the original project cwd from their own worktree sessions.
- Ordinary leader decisions, merge planning, status inspection, and final answers do not require user confirmation.
- User confirmation is required for conflict resolution choices, explicit need-info pauses, and final apply/merge into the user's current branch.

Later versions can add an explicit merge-capable member, deterministic git adapter, or built-in integrator if this leader-based merge flow is not reliable enough.

## 10. Assignment Validation

Leader planning output should include enough metadata to avoid sending write work to readonly members:

```json
{
  "type": "plan",
  "assignments": [
    {
      "id": "backend-api",
      "to": "backend-developer",
      "task_type": "implementation",
      "requires_file_write": true,
      "expected_files": ["server/app.ts", "server/db.ts"],
      "depends_on": []
    }
  ]
}
```

Validation rules:

- `to` must match an existing team member role.
- `requires_file_write = true` requires `file_access = 'read_write'`.
- implementation/fix tasks require `file_access = 'read_write'`.
- review/analysis/planning tasks may go to `read_only` members.
- Unknown or incompatible assignments should fail planning and ask the leader to re-plan.

## 11. UI Requirements

Team creation UI:

- Let the user choose `read_only` or `read_write` for each member.
- Show the execution cwd for each member.
- Show generated worktree branch/path for read-write members before creation.
- Keep the first version focused on file access mode; do not expose a broad capability editor yet.

Team run UI:

- Show each member's file access mode.
- Show worktree branch/path for read-write members.
- Show readonly members as operating in the original team cwd.
- Show any tool-policy denial as part of the delivery stream.
- Require user confirmation only for conflict decisions, explicit need-info pauses, and final apply/merge into the user's current branch.

Permission UI:

- Show member role, file access mode, delivery id, cwd, and tool input.
- For readonly members, explain automatic denials.
- For unclear shell commands, highlight why user confirmation is required.
- For root-cwd git operations, make it clear that the operation affects the user's original project working directory.

## 12. Version Plan

### Phase A: Readonly/Read-Write Policy

- Add `file_access` to shared team member types and create-team input.
- Add `execution_cwd`, `worktree_path`, and `worktree_branch` fields to `team_member`.
- Add migration defaults for existing rows.
- Extend member initialization and delivery prompts with workspace policy blocks.
- Add plan validation for readonly versus write-required assignments.
- Add team permission policy wrapper.
- Add regex-based shell command classification.
- Add tests for readonly denials, read-write path boundaries, and user confirmation for unclear shell commands.

### Phase B: Read-Write Member Worktrees

- Detect whether `team.cwd` is inside a git repository.
- Create a worktree for each read-write member before creating its session.
- Store `execution_cwd`, `worktree_path`, and `worktree_branch`.
- Create read-write member sessions in their worktree cwd.
- Keep readonly member sessions in `team.cwd`.
- Show worktree metadata in the UI.

### Phase C: Parallel Scheduler

- Allow `max_parallel_members > 1`.
- Preserve single-member serialization.
- Preserve dependency gating.
- Default to parallel execution only when write-capable members are isolated in worktrees.
- Keep same-cwd write parallelism disabled by default.

### Phase D: Leader-Driven Merge

- Have workers report branch names, touched files, and test results.
- Have leader produce merge order and conflict expectations.
- Let leader make ordinary merge-plan and final-answer decisions without user confirmation.
- Ask the user only for conflict decisions, explicit need-info pauses, and final apply/merge into the user's current branch.
- Let leader execute allowed cwd git inspection/merge operations through the existing permission flow.
- Surface merge results and conflicted files in the team run UI.

### Later Options

- Add a generic member capability model if users need non-leader merge executors.
- Add a deterministic git adapter if agent-executed merge is too unpredictable.
- Add an optional built-in integrator member if separation becomes worth the extra session and token cost.
- Add advisory file-scope warnings for planning and merge-risk visibility.
- Add richer touched-file tracking from structured tools and shell output.
- Add a dedicated worktree table when integration, cleanup, or historical worktree state needs richer tracking.

## 13. Open Questions

- Should existing teams migrate to `read_write` for compatibility or `read_only` for safety?
- Should readonly members be allowed to run test commands by default, or should all test commands require user confirmation?
- How strict should shell command parsing be before the project needs a real shell parser?
- Should read-write worktrees be created for every read-write member at team creation, or should a later version introduce lazy session creation?
- Should leader merge happen in the original cwd first, or should a later version add an integration worktree before final apply?
