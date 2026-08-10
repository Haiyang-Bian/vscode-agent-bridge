# ADR 0008: Managed worktrees and single-commit promotion

- Status: Accepted
- Date: 2026-08-09

## Context

Dense experiment checkpoints solve buffer recovery but do not isolate saved files or private Git commits from a user's delivery branch. Agent-driven work needs a place where ten failed attempts can remain recoverable while the target branch receives only the accepted result.

## Decision

- Create each v0.4 managed experiment as a locked local Git worktree on a private `vscode-agent-bridge/experiment/*` branch.
- Run Git only through a fixed `execFile` allowlist. No MCP Git tool, arbitrary argument, shell, remote operation or Git configuration mutation is added.
- Require explicit user commands for worktree creation, private commits, synchronization, promotion and deletion.
- Treat a reachable, user-accepted private commit as the only promotable candidate.
- Stop when the target branch moves. Rebase only through a separate confirmed synchronization command.
- Promote the accepted tree by creating one temporary commit object whose only parent is the current target HEAD, then cherry-pick it in the target worktree and verify parent/tree invariants.
- Never push, automatically delete a worktree, prune worktrees, or use `reset --hard` for recovery.

## Consequences

Private trial commits remain ordinary local Git objects and can use the user's hooks and signing settings. Promotion can fail because of hooks or worktree state; automatic recovery is limited to `cherry-pick --abort`. A failed abort enters a recovery-required state and disables further managed writes until the user repairs the repository.
