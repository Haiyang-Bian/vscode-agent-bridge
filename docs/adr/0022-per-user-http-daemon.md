# ADR 0022: A per-user HTTP-only MCP daemon

- Status: Accepted (implementation plan approved by the project owner)
- Date: 2026-09-07
- Supersedes the client-launched STDIO decision in ADR 0001, the external-transport fixed-port restriction in ADR 0002, and the command-based installation in ADR 0004. The two-runtime split and the extension's authenticated descriptor/RPC boundary remain in force.

## Decision

Release 0.13.0 exposes the existing 64-tool catalog through MCP SDK 1.30.0 Streamable HTTP on `127.0.0.1` at `/mcp`. STDIO transport is removed. Internal extension RPC remains version 11, including compatibility with 0.12.0 extensions. Service configuration and management use their own version 1 contract.

One installed daemon belongs to the current Windows user, independent of the product version. A stable, ACL-restricted named pipe is held for the process lifetime. Repeated startup must authenticate and verify the existing service before returning success; an occupied but unverifiable endpoint is a failure. The service's bounded status/stop management protocol is separate from MCP and uses a different credential. It is never exposed as an MCP tool.

Formal state and versioned binaries live under the current user's `.vscode-agent-bridge/service` directory, outside AppData virtualization. A packaged Codex process, unpackaged VS Code and the external login task must resolve one location and identity. Local acceptance demonstrated that writing to a logical LocalAppData installation from packaged Codex instead reached its private MSIX cache and left Task Scheduler unable to find the EXE. User-profile path launch and explicit/default path identity equivalence are required regressions.

Management requests and replies use domain-separated HMAC-SHA256 proofs, fresh nonces, a 30-second timestamp window and a bounded replay cache. The management secret is never sent to an unverified pipe owner. A stop request binds the verified boot ID. HTTP health is checked only after the management response proves the server identity.

Management clients wait within a bounded deadline for the single pipe connection to become available, only before sending a request. A sent request is never replayed. The native adapter distinguishes a disconnected client from an empty nonblocking input buffer; these have different meanings despite both API operations using `ERROR_NO_DATA`. Delayed first writes and concurrent management clients are regression-tested against the actual Windows pipe.

Bun 1.3.11's Node-compatible repeated named-pipe bind crashes in the concurrency feasibility probe. The daemon therefore calls the narrow Windows named-pipe API through Bun's existing FFI module, using `FILE_FLAG_FIRST_PIPE_INSTANCE`, one pipe instance and nonblocking I/O. There is no resident launcher or third runtime. A compiled feasibility probe verified 20 simultaneous processes, one owner and 19 successful existing-owner confirmations. Production regression tests must also cover owner crash, untrusted occupancy, bounded management frames and handle cleanup. FFI is isolated to the Windows service adapter and must not be imported into the VS Code Extension Host.

The daemon transitions through `starting`, `ready` and `stopping`. Having no VS Code windows is normal: MCP initialization and catalog reads remain available, while IDE-dependent tools return `NO_VSCODE_INSTANCE`. Extension publication, discovery, initialization and degradation behavior remain unchanged; active registration and heartbeats are deferred.

Each client session receives a distinct MCP protocol server and cancellation domain. Shared state is limited to process discovery and privacy-preserving usage aggregates; there is no global selected window. Limits are 128 sessions, eight concurrent requests per session and 64 globally. Inactive sessions expire after 30 minutes without active work. Saturation rejects new work and never evicts executing work. Socket or SSE disconnect alone does not cancel IDE operations. Explicit MCP cancellation, session DELETE, request deadlines and service shutdown do. Side-effecting requests are never retried automatically; response replay is not offered.

The first installation allocates and persists a free port. Subsequent startup uses that port and fails explicitly if it is occupied. Every HTTP request requires a random 256-bit Bearer credential, an exact loopback Host, and either no Origin or the configured same-origin value. No CORS is enabled. Configuration, temporary publication files and credential-bearing backups are restricted to the current SID and SYSTEM before publication, failing closed on ACL errors. Logs and status omit credentials and management endpoint addresses.

The Task Scheduler logon task directly starts the hidden-console EXE under the current user's interactive token with least privilege. It ignores overlapping starts, has no runtime limit or idle/network/battery prerequisite, and retries failures every minute up to three times. CLI diagnostics and `service install/start/stop/restart/status/uninstall` remain short-lived. Shutdown rejects new work, allows up to ten seconds for completion, then aborts outstanding RPCs, flushes usage and releases all listeners and ownership handles.

The pinned Bun 1.3.11 build silently ignores both forms of the hide-console option (confirmed with API and CLI probes; upstream fix bun#36292). Packaging therefore validates the fresh unsigned x64 PE32+ image, applies the GUI subsystem flag and recomputes its PE checksum before hashing. Windows ImageHlp independently checks the checksum, and artifact acceptance executes diagnostics and the complete compiled service lifecycle. This build-only workaround adds no runtime process and must be reconsidered when the pinned toolchain changes.

Installation stages a versioned EXE and verifies it before stopping a prior daemon. It preserves prior task/configuration state, changes the logon action, verifies the new service, then commits the managed configuration. Failure restores previous configuration and startup state, stops only the candidate service and retains old binaries. Codex's managed TOML uses URL and authentication headers while preserving the tool whitelist and timeouts. Existing client-owned STDIO processes are left to drain naturally during migration.

Managed comments are not sufficient evidence of configuration ownership: external TOML editors can insert another plugin's table before the closing comment. Update and uninstall must verify that removing the marked range leaves every parsed non-bridge setting unchanged, otherwise they fail before changing service/configuration state. A migration acceptance comparison against the protected original backup enforces this boundary on the actual machine.

## Ownership and validation

The MCP package owns tool-session composition, HTTP sessions, Windows singleton/control, private service state, scheduler management and transactional installation. The extension owns IDE behavior and presents setup/Doctor through the bounded local CLI. The protocol package owns shared schemas, constants, errors and the single tool catalog; it remains a library.

Process, HTTP, ACL, session/cancellation and installer tests use distinct directories, identity namespaces, ports and logon tasks. Real IDE lifecycle tests and packaged HTTP acceptance supplement deterministic tests. Local migration follows isolated acceptance and must demonstrate a fresh Codex client reaching the daemon and successfully calling an IDE tool. Evidence distinguishes the one new daemon from remaining legacy client-owned processes. A second Windows user ACL test remains an explicit unverified boundary until actually executed.

## References

- [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Bun standalone executables](https://bun.sh/docs/bundler/executables)
- [Bun hide-console PE writer fix](https://github.com/oven-sh/bun/pull/36292)
- [Windows executable checksum API](https://learn.microsoft.com/en-us/windows/win32/api/imagehlp/nf-imagehlp-mapfileandchecksumw)
- [Bun FFI](https://bun.sh/docs/runtime/ffi)
- [Windows ConnectNamedPipe states](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe)
- [Windows named-pipe read and wait modes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-type-read-and-wait-modes)
- [MSIX AppData virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)
