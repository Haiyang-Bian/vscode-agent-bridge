# MCP server module

## Purpose

`packages/mcp-server` is the standalone STDIO process launched by an MCP client. It discovers VS Code windows, selects an instance, forwards bounded calls over authenticated local RPC and shapes responses according to the shared tool catalog.

## Ownership map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Process composition, MCP server lifecycle and bounded tool registration |
| `src/instances.ts` | Descriptor discovery, live probing and explicit instance selection |
| `src/rpc-client.ts` | Authentication, protocol initialization, request timeout and cancellation |
| `src/usage-insights.ts` | Privacy-preserving local aggregate event recording |

The package's tests mirror those four boundaries. `test/stdio.test.ts` is the closest proof that the exposed MCP surface matches the bounded catalog.

## Change rules

- Keep STDIO transport output valid; diagnostic output must never corrupt MCP messages.
- Do not use this process as a shortcut around extension trust, policy or mutation enforcement.
- Do not return descriptor tokens, pipe/socket names or raw transport failures.
- Preserve clear distinction between no instance, multiple instances, unavailable instances, timeout, cancellation and protocol mismatch.
- Derive tool behavior and metadata from `packages/protocol`; avoid hand-maintained parallel name/category lists.
- Usage recording is an aggregate evidence channel, not telemetry for source, inputs, outputs or user identity.

## Investigation route

For discovery failures, start in `instances.ts` and its tests. For hanging/aborted calls, start in `rpc-client.ts`. For a tool-shape mismatch, start in the protocol catalog and STDIO contract test before the extension handler.

Use the `mcp-runtime` domain for focused diagnosis. Composition-root or cross-runtime changes can automatically escalate to full validation and E2E.
