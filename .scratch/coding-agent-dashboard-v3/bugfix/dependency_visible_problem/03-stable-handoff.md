# Phase 3: Optional Stable Dependency Handoff

> Status: future hardening
> Priority: optional
> Goal: make a dependency input reproducible even if the upstream worktree changes or is cleaned up later.

## Why This Is Not Required First

After Phases 1 and 2, a dependent member receives the correct upstream RESULT and can read the declared upstream worktree without being able to modify it. That directly fixes the observed Architect -> coder workflow.

The remaining limitation is that a live worktree is mutable. An upstream member can receive a later task, amend its files, or have its worktree removed during cleanup. A downstream worker that starts later could then inspect a different state from the one that originally satisfied the dependency.

## Two Explicit Handoff Modes

Introduce a handoff mode only when a plan needs this stronger guarantee:

```text
live_worktree  Read the declared upstream worktree in read-only mode.
git_commit     Read a fixed, committed Git revision.
snapshot       Read immutable copies of declared output files.
```

`live_worktree` is the Phase 2 default. It has the lowest implementation cost and supports uncommitted output.

`git_commit` requires the upstream member to report a commit SHA and have a clean worktree. The orchestrator records the commit SHA, not only a branch name. Downstream members receive a read-only checkout or equivalent view of that exact revision.

`snapshot` captures explicit output files at completion. It is suitable for documents, generated schemas, or other file-level contracts where a commit is unnecessary.

## Artifact Metadata

If `snapshot` is enabled, the worker RESULT should report structured artifacts, for example:

```json
{
  "path": "ARCHITECTURE.md",
  "kind": "document",
  "handoff": "snapshot",
  "description": "Protocol, module boundaries, and implementation order"
}
```

The orchestrator validates that each declared path is a regular file below the upstream `execution_cwd`, then stores an immutable copy together with path, size, and content hash. It must reject path traversal and symlink escapes.

The artifact store is orchestrator-owned. It should not be a generally browsable shared directory. Only delivery dependencies may obtain a read-only view of the relevant snapshot.

## Source-Code Baseline Is a Separate Decision

Some downstream tasks need to use upstream code as the starting point, not merely inspect it. Do not make that an implicit side effect of a dependency.

The plan must explicitly request one of:

- a commit merge or cherry-pick into the downstream worktree; or
- a workspace overlay with documented conflict handling.

Automatic branch merging is unsafe as a default because agents may have uncommitted changes, branches can include unrelated modifications, and multiple dependencies can conflict.

## Acceptance Criteria

- A `git_commit` handoff always resolves to the recorded commit SHA, even after the named branch advances.
- A `snapshot` handoff remains readable after the source worktree is changed or removed.
- Only declared artifacts are captured and exposed to downstream deliveries.
- A missing required commit or artifact prevents the handoff from being labelled successful.
- Source-code merge behavior occurs only when a plan explicitly requests it.

## Non-Goals

- Do not block Phase 1 or Phase 2 on snapshot storage.
- Do not automatically merge every upstream worktree into every dependent worktree.
- Do not expose all artifacts to every member of the team.
