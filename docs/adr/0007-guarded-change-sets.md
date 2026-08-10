# ADR 0007: Guarded one-time text change sets

- Status: Accepted
- Date: 2026-08-09

## Decision

- Separate preparation from application.
- Require explicit instance and session identifiers on every mutating MCP call.
- Bind each target to a full-content SHA-256 and, when open, a VS Code document version.
- Expire prepared change sets after ten minutes and allow one application attempt.
- Validate every target before using a text-only WorkspaceEdit; reject the whole operation on any
  stale precondition.
- Apply only edits to existing `file:` documents or already-open `untitled:` buffers.
- Reject file creation, deletion, rename, provider commands, terminal execution, and unrestricted
  filesystem access.
- Never save after application; the dirty editor buffer remains the user-visible review boundary.
