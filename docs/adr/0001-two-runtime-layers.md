# ADR 0001: Two runtime layers with a shared protocol package

- Status: Accepted
- Date: 2026-08-02

## Context

Codex needs a conventional MCP endpoint, while IDE-native state is only available inside the VS Code Extension Host. Coupling MCP framing directly to the extension would mix client lifecycle, editor lifecycle, instance discovery, and VS Code API access.

## Decision

Use two runtime layers:

1. A local STDIO MCP Server started by Codex.
2. A VS Code Extension that owns all VS Code API access.

The runtimes communicate with authenticated JSON-RPC 2.0 over a local named pipe on Windows or a Unix domain socket on Unix-like systems. `packages/protocol` contains schemas and shared utilities but does not run independently.

The initial release supports local desktop workspaces. Remote SSH, WSL, Dev Containers, and browser-hosted VS Code are detected but not claimed as supported.

## Consequences

- MCP and VS Code lifecycles can restart independently.
- Multiple VS Code windows require explicit instance discovery and routing.
- The internal protocol can evolve independently from MCP tool schemas, subject to a versioned handshake.
- Remote extension hosts will require a future relay or tunnel design.
