# MCP server module

## Purpose

`packages/mcp-server` is one shared HTTP daemon per current Windows user, started at login. MCP clients connect to its persisted loopback address. It discovers VS Code windows, selects an instance explicitly, forwards bounded calls over authenticated local RPC and shapes responses according to the shared tool catalog. See [ADR 0022](../../adr/0022-per-user-http-daemon.md) and [installation and recovery](../../installation.md).

## Ownership map

| File | Responsibility |
| --- | --- |
| `src/index.ts`, `src/service-cli.ts` | HTTP-only process entry, diagnostics and local management commands |
| `src/mcp-session.ts` | Per-session factory, typed tracked-tool registration and catalog completeness |
| `src/http-runtime.ts`, `src/request-context.ts` | HTTP authentication/admission, session isolation, deadlines and cancellation scopes |
| `src/service-daemon.ts`, `src/service-control.ts`, `src/service-auth.ts` | Single owner, authenticated management requests/responses and bounded shutdown |
| `src/windows-service-native.ts`, `src/service-state.ts` | OS-exclusive local named pipe, protected DACLs, stable identity and atomic private files |
| `src/service-installer.ts`, `src/service-scheduler.ts`, `src/service-config.ts`, `src/service-errors.ts` | Transactional version installation, login task, managed TOML migration and redacted errors |
| `src/instances.ts` | Version-tolerant descriptor discovery, current live probing, incompatible-instance reporting and explicit selection |
| `src/rpc-client.ts` | Authentication, protocol initialization, request timeout and cancellation |
| `src/usage-insights.ts` | Privacy-preserving local aggregate recording, rotation, capacity, recurring prune and flush |

`test/http-runtime.test.ts` checks the entire MCP catalog and client isolation; `test/service-process.test.ts` tests 20 competing starts, crash recovery and occupied endpoints. `test/service-installer.test.ts` covers transaction failures; `scripts/test-http-service.ts` exercises real login tasks with the compiled EXE in an isolated installation.

## Change rules

- Keep the MCP surface HTTP-only. Diagnostics and local management return bounded JSON without credentials or IPC addresses.
- Do not use this process as a shortcut around extension trust, policy or mutation enforcement.
- Do not return descriptor tokens, pipe/socket names or raw transport failures.
- Preserve clear distinction between no instance, multiple instances, unavailable instances, timeout, cancellation and protocol mismatch.
- Derive tool behavior and metadata from `packages/protocol`; typed registration rejects duplicates and startup fails if any catalog name is missing.
- Usage recording is an aggregate evidence channel, not telemetry for source, inputs, outputs or user identity. Active files rotate at 1 MiB, append is bounded by 20 MiB total and daemon shutdown awaits the queue.
- A disconnected HTTP socket is not cancellation. Only explicit MCP cancellation, session DELETE, deadlines and shutdown cancel the relevant RPC scope. Do not retry mutations.
- Preserve 128 sessions, 8 requests per session, 64 global requests and 30-minute inactive-session expiry. Busy requests retain admission until the operation actually settles.

## Investigation route

For discovery failures, start in `instances.ts` and its tests. For hanging/aborted calls, start in `http-runtime.ts`, `request-context.ts` and `rpc-client.ts`. For a tool-shape mismatch, start in the protocol catalog and HTTP contract test before the extension handler.

Use the `mcp-runtime` domain for focused diagnosis. Composition-root or cross-runtime changes can automatically escalate to full validation and E2E.
