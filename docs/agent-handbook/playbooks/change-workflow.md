# Change workflow

## 1. Orient without scanning

1. Read the root and closest nested `AGENTS.md` plus the matching handbook route.
2. Inspect `git status` and the current diff before assuming the baseline.
3. Locate the exact symbol or path with `rg`.
4. Read its nearest deterministic tests, direct imports and callers.
5. Widen to a neighboring module only when a contract, state transition or failure crosses that boundary.

Repository-wide traversal is a last resort for ownership discovery, security review or coverage auditing—not the default start for a feature or bug.

## 2. Establish the change boundary

Write down, at least mentally:

- the owning runtime/package;
- the authoritative contract or state owner;
- whether the change is read-only, persistent, process-executing, user-confirmed or open-world;
- the stale-state/precondition model;
- the nearest regression layer;
- whether an Accepted ADR constrains the design.

If the feature requires a new architectural/security choice, create or propose an ADR before hiding that decision inside implementation details.

## 3. Plan validation before implementation

Run `bun run test:plan` before deciding test scope. Check that the selected domain matches the ownership map. If a new production path is unclassified, update the registry rather than relying forever on the fail-closed fallback.

For a bug, first reproduce or encode the failure at the closest deterministic boundary. Use E2E only when the behavior requires the real Extension Host, IPC, VS Code API, Task/terminal, Debug adapter, Git worktree or packaged install boundary.

## 4. Implement incrementally

- Preserve the existing architecture and make the smallest coherent change.
- Keep protocol, handlers and managers aligned without duplicating validation or catalogs.
- Preserve unrelated user changes in the worktree.
- Do not widen capability or weaken security to make a test convenient.
- Update comments/docs only when they explain a durable invariant, ownership rule or non-obvious failure mode.

Broad refactors, new production dependencies, new generic capabilities or changes to user-confirmed boundaries require explicit review.

## 5. Validate from narrow to broad

1. Run the closest changed/regression test.
2. Run `check:affected` or the selected domain command.
3. Run the selected E2E scenario only if required.
4. Run full/repeat/artifact gates only when the classifier or integration boundary requires them.
5. Do not rerun a passing gate after documentation-only edits or unchanged state.

On failure, preserve the exact error, identify the failing layer and rerun the smallest failing command after a fix. See [testing](testing.md) and [debugging](debugging.md).

## 6. Close out

- Re-run the impact planner if the final changed-file set differs materially from the initial plan.
- Use `git diff --check` and inspect the final scope.
- Update the handbook/ADR/test registry when ownership or routes changed.
- Record routine validation in the task handoff and commit message. Create a dated audit only for standalone test/audit/release work.
- Create a focused commit at the meaningful milestone; do not mix unrelated cleanup.
