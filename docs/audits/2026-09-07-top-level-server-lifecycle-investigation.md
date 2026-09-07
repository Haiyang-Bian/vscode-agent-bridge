# Top-level MCP server lifecycle investigation

- Date: 2026-09-07, observations in Asia/Shanghai time.
- Status: `completed_with_findings`.
- Scope: process multiplicity, STDIO ownership and exit, IDE-independent tool discovery, and the proposed shared service lifecycle. No runtime implementation changes.
- Source baseline: commit `875812f`, release `0.11.0`, internal bridge protocol v10; initially clean checkout.
- Live installation: Windows x64 executable `0.12.0`; one discovered VS Code extension instance reported internal bridge protocol v11 and `ready`.
- Tested executable SHA-256: `6d472a953c5e7c2897144ad6c95e474ee242129ee09245113eace0369641dff2`.

## Method and preconditions

Read the handbook, MCP composition, managed configuration, instance discovery, local RPC, publication and existing STDIO test. Source observations below describe the checked-out version; direct process and executable tests describe the live 0.12.0 installation. Their complete implementations were not assumed identical.

Read Windows process metadata without terminating existing processes. The first focused snapshot found 19 bridge executables, all with parent PID 26600 (`codex.exe` running `app-server`), one identical executable path, and creation times between 13:04:30 and 14:11:52. The existing managed configuration uses a command-based STDIO endpoint. The checked-in generator also writes a command-based endpoint.

The 19-process snapshot reported 1892.4 MiB aggregate working set and 6291.4 MiB aggregate private bytes. Working-set sums may count shared pages more than once; private bytes are committed private memory, not measured resident physical memory.

At 14:35:46 a bounded PowerShell probe started two new processes with the same fresh, isolated registry. It initialized both MCP sessions, listed tools and instances, called editor context with no registered IDE, then closed both stdin streams. It used a 5-second `WaitForExit` deadline per process. The probe never exposed the real registry to either child. A cleanup fallback was restricted to processes created by the probe and was not needed.

At 14:36:34, after another live instance-discovery call, the original bridge population was 17, with the same parent and no creation time later than 14:11:52. Both probe PIDs were absent. No existing bridge process was terminated by this investigation. The reason two original processes disappeared was not identified.

## Result matrix

| Check | Result | Evidence / limit |
| --- | --- | --- |
| User-reported duplicate bridge processes | Confirmed | 19 actual bridge executables initially; 17 in the later snapshot |
| Common launcher and binary | Confirmed | Same live Codex app-server parent and same 0.12.0 executable |
| Simultaneous executable instances | Confirmed | Both isolated MCP sessions initialized while both child processes remained alive |
| Tools available without VS Code | Pass | Both isolated sessions returned 64 tools and zero instances |
| IDE call without VS Code | Pass | Both returned `NO_VSCODE_INSTANCE` as an MCP tool error |
| Normal STDIO EOF shutdown | Pass in two probes | Both exited with code 0 after stdin closed, within the per-process deadline; no forced cleanup |
| Every tool call creates another executable | Not observed | Later live discovery had no newer bridge process; population decreased |
| Existing processes are abandoned/leaked | Unproven | No mapping from every process to its owning Codex client/session or open stdin handles |
| Abrupt parent death / pending mutation cancellation | Untested here | Normal EOF does not establish these behaviors |
| Shared HTTP service, lock and active registration | Not implemented in inspected source | Proposed architecture, not an accepted decision or tested feature |

## Findings

1. **Medium: the current transport lifecycle does not meet the requested shared-service lifecycle.** The managed configuration supplies an executable command; [MCP composition](../../packages/mcp-server/src/index.ts) uses `StdioServerTransport`. These are client-owned streams. Multiple clients cannot attach their unrelated stdin/stdout pipes to the first process by adding a mutex. The live population confirms repeated child creation, but does not establish the precise Codex ownership granularity. Recommendation: use a directly addressable, shared Streamable HTTP service if one process across clients is the product requirement.

2. **Medium: the accumulated process population has material resource cost, but an EOF exit defect was not reproduced.** Two isolated 0.12.0 processes exited normally on EOF. The inspected source explicitly handles SIGINT/SIGTERM and contains no singleton manager; absence of explicit stdin-end code alone is not evidence of an executable exit bug. Recommendation: investigate Codex-side connection ownership before labeling the existing population leaked; do not bulk-kill processes based on count alone.

3. **Medium: registration is currently passive discovery rather than registration into a permanent Server.** [BridgeHost](../../packages/vscode-extension/src/bridge-host.ts) publishes a per-window descriptor; [instance discovery](../../packages/mcp-server/src/instances.ts) reads descriptors and authenticates/probes each endpoint. There is no central process holding a durable live-window registry. Recommendation: a future daemon can initially reuse this discovery path, then add authenticated registration, connection-loss/lease handling and automatic re-registration after service restart.

4. **Low: IDE-independent tool availability already exists.** The isolated executable advertised all tools without VS Code and returned `NO_VSCODE_INSTANCE` for editor context. The main missing capability is shared process ownership. A future service should additionally distinguish offline, initializing, degraded, disabled/untrusted, incompatible and ambiguous instances where authorized status information is available; a missing descriptor alone cannot establish why an IDE is absent.

5. **Medium: service migration changes an accepted architecture/security boundary.** [ADR 0001](../adr/0001-two-runtime-layers.md), [ADR 0002](../adr/0002-local-security-boundary.md) and [ADR 0004](../adr/0004-windows-distribution-and-managed-codex-config.md) specify a client-launched STDIO process, random local IPC endpoints, and command-based configuration. A directly addressable HTTP service needs a new reviewed ADR covering authentication, loopback binding, Origin/Host checks, per-user identity, concurrent clients, cancellation isolation, startup ownership and upgrades. It need not add a third production runtime: the existing MCP package can become the daemon while the extension remains the IDE executor.

## Proposed lifecycle for discussion

The proposed singleton scope is the current OS user, with deployment channels separated deliberately if required. Normal version upgrades should not accidentally create a second singleton namespace. A user-session daemon can run without administrator privileges; installation as an OS service is a separate deployment choice.

- A designated lifecycle owner starts the daemon independently of Codex tasks and IDE windows. Codex uses a configured HTTP URL and establishes independent MCP sessions to that process.
- An OS-backed ownership lock and an authenticated readiness check establish one owner. A PID or the mere existence of a file is insufficient. Competing starts detect the existing owner and terminate their own duplicate startup attempt.
- The daemon publishes its MCP endpoint and stable tool catalog before any IDE connects. Zero connected IDEs is an ordinary operating state.
- Each extension registers when its allowed state is available, publishes readiness changes, and reconnects after daemon restart. If VS Code starts first, bounded retry or retained discovery metadata allows later registration.
- MCP client disconnect cancels that client's pending requests and releases its session, without stopping other clients or the daemon. IDE disconnect makes that instance unavailable and invalidates its live handles without stopping the daemon.
- Tool routing remains explicit. Authentication and a shared process do not replace extension-side trust, root, experiment and stale-state checks. A global mutable selected-window variable would be unsafe across clients.
- Upgrade and shutdown have a single owner, stop accepting work, drain or cancel pending requests within a bound, close registrations/sessions and release singleton ownership. External effects already performed are not automatically rolled back.

An optional STDIO proxy can preserve old clients, but each such client still launches a proxy process. It therefore does not meet a requirement to eliminate per-client executable processes; direct HTTP is the proposed primary integration.

Codex's [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) confirms both command-based STDIO and URL-based Streamable HTTP, including bearer-token configuration. It does not establish how this particular desktop build maps every retained task to child processes.

## Side effects and artifacts

- No existing processes were stopped; no settings, live registration descriptors, installed binaries, workspaces or experiment contents were changed.
- Two isolated probe children were created and both exited normally. Their bounded tool calls could write usage-insight files only under their isolated registry.
- Ignored local probe script and JSON evidence are under `<REPOSITORY>/artifacts/lifecycle-investigation-2026-09-07/`. No release artifacts were built.
- This new dated report and its audit-index entry are the only tracked changes.
- `bun run test:plan` initially failed closed because the sandbox prevented Bun from spawning Git. A read-only retry outside that restriction reported `Risk: none`, zero changed paths and no gates before documentation was added. This diagnostic was not reported as a successful source test run.

## Closure and next gate

The inspection is complete; implementation and process-leak attribution remain separate work. No service was installed and no architecture proposal was marked accepted.

Before implementation, review the daemon lifecycle and security ADR. Acceptance should demonstrate one daemon across simultaneous clients, correct concurrent-start ownership, daemon availability with no IDE, client/IDE startup in either order, IDE reload, daemon restart with re-registration, one-client cancellation isolation, protocol mismatch, and bounded upgrade/shutdown behavior. Classify implementation changes through the affected-test planner; transport/composition/security changes are expected to require its full gate and relevant real integration scenarios. Documentation-only closeout requires the documentation impact plan and `git diff --check`.
