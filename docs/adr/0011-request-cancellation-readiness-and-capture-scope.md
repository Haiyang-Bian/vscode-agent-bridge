# ADR 0011: Request cancellation, bridge readiness and experiment capture scope

- Status: Accepted
- Date: 2026-08-10
- Release: 0.6.1

## Context

The first v0.6.0 self-bootstrap audit found two conflicting lifecycle boundaries. An Agent write waiting for a native onboarding prompt could exceed the MCP server's five-second RPC timeout and later mutate workspace settings after the caller had already received `TIMEOUT`. At reload, the extension also recovered experiment storage before registering its bridge descriptor, making a slow or large recovery indistinguishable from an unavailable extension.

The audited experiment had also captured a large number of Git-ignored build artifacts through the broad workspace file watcher. Those snapshots inflated future checkpoint events and recovery work without representing source changes that Git or an open editor considered relevant.

## Decision

Bridge descriptors and initialization results expose one of three lifecycle states: `initializing`, `ready` or `degraded`. The extension starts the authenticated host before experiment-store recovery. Initialization remains available in every lifecycle, while state-dependent methods return `BRIDGE_INITIALIZING` or `BRIDGE_DEGRADED` until the host is ready.

Interactive Agent writes use a bounded 90-second inner RPC timeout. The MCP SDK request signal is propagated through the client connection, bridge host and workspace onboarding. Closing or cancelling the request destroys that request's socket; the host aborts the handler and the handler checks cancellation after user interaction and immediately before durable mutation. Ordinary read requests retain the five-second default. The bridge's ten-second idle timeout is disabled only while an authenticated request is pending and is restored afterwards.

Recovery validates each content-addressed Blob at most once per initialization, while still reading every immutable checkpoint event. Existing experiment events and Blobs are neither migrated nor deleted.

Every per-session manifest read-modify-write operation uses the same manifest mutation queue. Immutable event files remain separately atomic, but checkpoint, evidence, warning, storage, acceptance, lifecycle, pin and rename metadata cannot overwrite a newer manifest snapshot from another operation.

For Git-backed experiments, workspace watcher events are captured only when their path is currently Git-dirty or the document is open in VS Code. This excludes ignored build output while preserving unsaved/open-buffer observation. If the bounded Git status check fails, the extension conservatively captures the event and records only a path-free warning in its output channel.

## Consequences

- A cancelled onboarding request cannot later write workspace settings or create an experiment.
- Slow recovery is discoverable and has a stable machine-readable state instead of presenting an empty registry.
- Future checkpoints do not grow from ordinary Git-ignored build output; legacy journals remain available and benefit from deduplicated Blob validation.
- Concurrent automatic evidence or checkpoint capture cannot silently undo an Agent rename or lose another manifest field update.
- The bridge still exposes exactly 26 IDE-bounded tools. No generic filesystem, terminal input, shell, command or Git surface is added.
- A real reload against the existing large journal remains a separate self-bootstrap validation gate for the patch candidate.
