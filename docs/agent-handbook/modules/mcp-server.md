# MCP server module

## Purpose

`packages/mcp-server` is the standalone STDIO process launched by an MCP client. It discovers VS Code windows, selects an instance, forwards bounded calls over authenticated local RPC and shapes responses according to the shared tool catalog.

## Ownership map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Process composition, typed tracked-tool registration, catalog completeness and shutdown flush |
| `src/instances.ts` | Version-tolerant descriptor discovery, current live probing, incompatible-instance reporting and explicit selection |
| `src/rpc-client.ts` | Authentication, protocol initialization, request timeout and cancellation |
| `src/usage-insights.ts` | Privacy-preserving local aggregate recording, rotation, capacity, recurring prune and flush |

The package's tests mirror those four boundaries. `test/stdio.test.ts` is the closest proof that the exposed MCP surface matches the bounded catalog.

## Change rules

- Keep STDIO transport output valid; diagnostic output must never corrupt MCP messages.
- Do not use this process as a shortcut around extension trust, policy or mutation enforcement.
- Do not return descriptor tokens, pipe/socket names or raw transport failures.
- Preserve clear distinction between no instance, multiple instances, unavailable instances, timeout, cancellation and protocol mismatch.
- Derive tool behavior and metadata from `packages/protocol`; typed registration rejects duplicates and startup fails if any catalog name is missing.
- Usage recording is an aggregate evidence channel, not telemetry for source, inputs, outputs or user identity. Active files rotate at 1 MiB, append is bounded by 20 MiB total and STDIO shutdown awaits the queue.

## Investigation route

For discovery failures, start in `instances.ts` and its tests. For hanging/aborted calls, start in `rpc-client.ts`. For a tool-shape mismatch, start in the protocol catalog and STDIO contract test before the extension handler.

Use the `mcp-runtime` domain for focused diagnosis. Composition-root or cross-runtime changes can automatically escalate to full validation and E2E.
