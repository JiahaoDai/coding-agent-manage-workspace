# Phase 2: Expose Declared Dependency Worktrees as Read-Only

> Status: proposed
> Priority: high after Phase 1
> Goal: a downstream member can inspect a declared upstream worktree but cannot modify it or any other sibling worktree.

## Problem

Phase 1 gives downstream members the correct result text, but an architectural result may refer to a complete document or a larger code change. A summary alone is not always enough.

The desired collaboration model is not "never read outside the cwd." A dependent worker should be allowed to inspect the worktree that produced the dependency. The required safety boundary is that it must not modify any path outside its own `execution_cwd`.

Today that boundary does not exist. Separate Git worktrees provide separate working copies and branches, but do not impose operating-system write restrictions.

## Access Model

For each running member process:

```text
own execution_cwd:                     read-write
declared upstream dependency worktree: read-only
other sibling worktrees:               unavailable, or read-only at most
```

Only direct dependency worktrees should be exposed. A member must not receive a broad parent directory from which it can enumerate every team worktree.

## Dependency Context

When the upstream member has a worktree, Phase 1's result context should additionally include:

```text
Dependency: Architect
Worktree: /managed/path/.../architect
Branch: agent-team/<team-id>/architect
Commit: <HEAD at dependency completion, if available>
Access: read-only
```

The commit SHA is a diagnostic and reproducibility marker. It does not replace the worktree path: uncommitted output is visible only in the worktree. If the worktree is dirty, the prompt should say so rather than implying the branch fully represents the output.

The member prompt should state:

```text
You may read the explicitly listed dependency worktrees.
You may create, modify, delete, rename, or change permissions only inside your execution cwd.
```

## Enforcement

Prompt guidance alone is insufficient. The adapter's executing process must receive filesystem permissions matching the access model.

The preferred implementation is process-level filesystem sandboxing or equivalent mount rules:

- mount the member worktree read-write;
- expose each declared dependency worktree read-only;
- hide unrelated sibling worktrees;
- continue to provide the minimal runtime, package-cache, and Git metadata paths required by the selected adapter.

When worktrees share Git metadata, the sandbox design must permit the member's legitimate Git operations on its own branch without granting write access to sibling working trees.

Do not implement this as a command-string denylist. Detecting `rm`, `cp`, shell redirection, or `chmod` is not sufficient because a process can write through scripts, Node, Python, symlinks, or child processes.

## Scheduling Integration

Before starting a downstream delivery, the orchestrator should resolve its direct dependencies and build an execution access specification:

```ts
interface MemberExecutionAccess {
  writable_root: string;
  read_only_dependency_roots: string[];
}
```

The access specification must be passed to the adapter/session execution layer, not only interpolated into the prompt. The same list is used to render the dependency context, so the visible paths and actual permissions cannot drift apart.

If an upstream dependency has no worktree, only its Phase 1 result is available. The scheduler must not invent a filesystem path.

## Acceptance Criteria

- A downstream member can read `ARCHITECTURE.md` from an explicitly declared Architect worktree.
- A write, delete, rename, chmod, or symlink-based write targeting that Architect worktree is rejected.
- The downstream member can still write and commit inside its own worktree.
- Unrelated team worktrees are not exposed as dependency paths.
- A missing or removed upstream worktree produces a clear dependency-context warning rather than a misleading path.

## Tests

Add integration coverage for:

- dependency worktree read succeeds;
- write outside `execution_cwd` fails, including a path using `..` and a symlink escape;
- writing inside `execution_cwd` succeeds;
- only direct dependency worktrees appear in the process access specification and prompt;
- no-worktree dependency still provides its Phase 1 result.
