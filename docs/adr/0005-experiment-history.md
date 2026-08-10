# ADR 0005: Separate experiment history from delivery history

- Status: Accepted
- Date: 2026-08-09

## Context

Agent-driven development produces many recovery points whose correctness is not yet known. Using
ordinary Git commits for every recovery point pollutes the delivery history and makes a temporary
checkpoint appear accepted.

## Decision

- Persist dense experiment checkpoints outside the repository in extension global storage.
- Treat save, checkpoint, acceptance, finalization, and Git commit as distinct events.
- Require a user-started experiment before any MCP document mutation.
- Keep one active writer lease per experiment and record incomplete capture honestly.
- Let v0.3 finalize metadata and a net diff without creating a Git commit.
- Reserve managed worktree sessions for v0.4, where private commits can be promoted as one commit.

## Consequences

Experiment snapshots may contain sensitive source code. They remain local, have bounded retention,
can be deleted explicitly, and are never included in diagnostics, logs, VSIX files, or telemetry.
