# ADR 0002: Local security boundary

- Status: Accepted
- Date: 2026-08-02

## Context

An editor bridge can expose unsaved code, workspace metadata, and eventually file mutations. A listener without authentication or a generic command executor would create a high-risk local control surface.

## Decision

- Use a random UUID for every extension instance and a cryptographically random 256-bit authentication token.
- Store discovery descriptors in a per-user registry directory with best-effort owner-only permissions.
- Use random local pipe or socket names; do not bind a fixed TCP port.
- Require `bridge/initialize` authentication before accepting any capability request.
- Apply a one-megabyte message limit and bounded request timeouts.
- Respect VS Code Workspace Trust. Future mutating methods must reject untrusted workspaces.
- Never expose a generic `vscode.commands.executeCommand`, terminal execution, extension installation, or unrestricted settings operation.
- Keep tokens, pipe endpoints, document contents, and stack traces out of MCP results and normal logs.

## Trust model

The bridge protects against accidental access and unrelated processes without the discovery token. It does not claim isolation from malicious code already executing as the same operating-system user. Stronger isolation would require OS-specific credential and ACL work.

## Failure behavior

Authentication failures close the connection. Protocol mismatches, missing instances, ambiguous routing, timeouts, and unsupported remote contexts return stable structured error codes.
