# ADR 0003: Tool contracts and rollout order

- Status: Accepted
- Date: 2026-08-02

## Context

Codex already has filesystem and shell tools. Duplicating them through VS Code would add ambiguity without providing IDE-specific value.

## Decision

The initial MCP surface contains only:

- `vscode_list_instances`: list registered VS Code windows without returning credentials or IPC endpoints.
- `vscode_get_editor_context`: return active editor, visible editors, selections, visible ranges, dirty state, document version, workspace folders, trust state, and remote host name.

Both tools are read-only, idempotent, and closed-world operations.

Later read-only methods should add diagnostics, document symbols, definitions, references, hover information, and code-action discovery. Navigation and diff display form a separate UI-effect category. Mutating methods are added last and must carry a document version or content-hash precondition.

## Result conventions

Every result identifies the VS Code instance and relevant workspace. Large result sets must support limits and explicit truncation. Expected failures use stable codes rather than raw stack traces:

- `NO_VSCODE_INSTANCE`
- `AMBIGUOUS_INSTANCE`
- `WORKSPACE_UNTRUSTED`
- `STALE_DOCUMENT_VERSION`
- `AUTHENTICATION_FAILED`
- `PROTOCOL_MISMATCH`
- `UNSUPPORTED_REMOTE`
- `TIMEOUT`
- `RESULT_TRUNCATED`
- `INTERNAL_ERROR`
