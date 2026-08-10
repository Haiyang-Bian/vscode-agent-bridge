# ADR 0017: Reviewed extension adapters

- Status: Accepted
- Date: 2026-08-10
- Applies to: v0.11.0

## Context

VS Code extensions can expose valuable language-specific state that is not available through the stable, generic VS Code provider APIs. A generic bridge to contributed commands or extension exports would also let an MCP caller cross an unreviewed capability boundary, activate arbitrary code and pass unvalidated payloads.

## Decision

The Bridge uses a static adapter catalog. Every adapter fixes the extension ID, supported version range, state schema, activation behavior and sensitivity. Catalog listing reads only installed manifest metadata and never activates an extension. An explicit state request may activate only the extension attached to the selected reviewed adapter. Missing, incompatible or changed APIs fail closed.

The first adapter is `python.environment` for `ms-python.python`. It imports Microsoft's pinned `@vscode/python-extension` facade and calls only `ready`, `getActiveEnvironmentPath` and `resolveEnvironment`. It returns the active interpreter path, environment type/name, Python version and bitness. It does not expose environment variables, packages, credentials, logs, commands or extension exports to MCP.

No generic adapter action is added. A future write action requires its own protocol contract, side-effect annotations, input validation and review.

## Consequences

- Agents can inspect a useful Python workspace state after an explicit, visible integration request.
- Listing integrations cannot unexpectedly activate installed extensions.
- Activation remains an open-world, non-idempotent observation in the MCP catalog even though the returned operation is read-only.
- New extension support requires a code review and release instead of arbitrary runtime discovery.
