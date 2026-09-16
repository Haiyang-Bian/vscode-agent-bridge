# Phase 1 shared HTTP daemon acceptance

- Date: 2026-09-07
- Status: `completed_with_findings`
- Scope: HTTP-only 0.13.0 daemon, current-user singleton and login startup, transactional installation, Codex migration and real IDE calls. RPC v11 and all 64 tool contracts are preserved. Active extension registration is deferred.
- Environment: Windows x64, pinned Bun 1.3.11, VS Code 1.136.1, MCP SDK 1.30.0, actual local Codex CLI clients. No Marketplace publication or release tag.

## Baseline and revisions

The remote v0.12 work was needed and was integrated before this feature. The [separate baseline report](2026-09-07-v012-master-integration.md) records the two test-environment corrections, safe branch cleanup and successful [master CI at `2b7e366`](https://github.com/Haiyang-Bian/vscode-agent-bridge/actions/runs/34095891042). A final fetch and CI query confirmed that revision and success; the old development branch is absent.

Implementation remains on `codex/shared-http-daemon`, separate from `master`. Production and build inputs were finalized at `74a83d62e35af6689a4b9cb1dc783ce7f356580d`; subsequent handoff edits are documentation only. Focused milestones include the ADR (`df36d4f`), runtime (`662683a`), installer/Doctor (`9182a0a`), management pipe fix (`1905b41`), artifact lifecycle coverage (`fc4e6d7`), MSIX path fix (`89becc6`), configuration ownership fix (`acd2390`) and hidden-console packaging fix (`74a83d6`). The pre-existing investigation and audit index were preserved in `2d665e4`.

## Method and gates

Impact planning preceded validation. The transport, process, installation and E2E infrastructure changes selected complete checks, two independent full Extension Host runs and artifacts. The subsequent managed-configuration correction selected a new complete check and full source E2E. The final build-only correction selected a complete check and artifacts, with no additional source E2E. Already-passing unrelated gates were not repeated.

Automated integration environments used unique service/registry directories, identities, ports, login tasks, workspaces and VS Code profiles. Login-task installation used a temporary directory under the user profile and asserted that its actual filesystem path equaled the path published to Task Scheduler. Candidate installation into the formal profile occurred only after isolated acceptance.

| Boundary | Result | Evidence and scope |
| --- | --- | --- |
| Final complete check | Pass | 176 tests across 42 files, zero failures; all workspace typechecks/builds and handbook/workspace checks |
| Source Extension Host E2E | Pass | Two complete isolated runs after lifecycle/infrastructure changes; another complete run after the configuration ownership fix |
| Final EXE/VSIX artifact gate | Pass | Release/layout/hash checks, compiled process tests, actual scheduler installation and rollback, normal-window lifecycle harness, installed-VSIX full E2E |
| Actual executable format | Pass | x64 PE32+ GUI subsystem 2; independent Windows ImageHlp checksum verification; piped diagnostics still execute |
| Singleton and crash recovery | Pass | 20 concurrent compiled launches: one owner and 19 authenticated existing-owner exits; crash releases ownership and permits a new boot at the persisted port |
| Management IPC | Pass | Delayed first write, rapid/concurrent clients, unauthenticated occupancy, bounded identity verification and graceful stop/usage flush |
| Client isolation and admission | Pass | Separate MCP sessions and cancellation domains; session/per-session/global limits; capacity remains held until canceled work settles |
| HTTP security | Pass | Wrong token, unsafe Host/Origin, invalid/expired sessions, duplicate IDs, replay rejection, port conflict and ACL establishment failure |
| Cancellation | Pass | Explicit cancel, deadline, DELETE and shutdown cancel only corresponding work; socket disconnect alone does not cancel; real pending onboarding cannot write after cancellation |
| No VS Code / later startup | Pass | Daemon remains ready, initialization and 64-tool catalog work; IDE tools return `NO_VSCODE_INSTANCE`; later windows become usable |
| Real window lifecycle | Pass | Initializing observed, actual reload republishes the descriptor, two windows require explicit routing, both window exits preserve the daemon PID |
| Other discovery states | Pass with fixture scope | Authenticated RPC fixtures exercise initializing, degraded, incompatible, replacement and exit; real local 0.12.0 extension is compatible over RPC v11 |
| Installer and recovery | Pass | Real login task, private ACLs, idempotent boot preservation, injected post-start upgrade rejection, restoration, managed restart and uninstall retaining version files |
| Configuration conflict | Pass | Unmarked/invalid/concurrently changed configuration and foreign tables inside managed comments fail safely; unrelated parsed settings remain intact |
| Formal Codex migration | Pass | Two fresh clients successfully call real IDE tools through the shared HTTP PID; one reads the actual saved user configuration |
| Login trigger configuration | Pass, bounded | Actual task registered, inspected and executed: InteractiveToken, LeastPrivilege, IgnoreNew, no runtime/network/idle/battery restriction, one-minute retries up to three |

Gate logs are retained under ignored `artifacts/phase1-evidence/`: `gui-final-check.log`, `msix-e2e-repeat.log`, `config-full-e2e.log` and `gui-artifact-acceptance.log`. These logs supplement the committed report; a checklist alone is not evidence of a run.

## Formal-machine result

The formal installation is under `<HOME>/.vscode-agent-bridge/service`. It uses a version-independent current-user identity, the persisted loopback HTTP endpoint, separate MCP/management credentials and private current-user/SYSTEM ACLs. Codex now uses URL and authentication headers, with the 64-tool allowlist and 10/120-second timeouts preserved; no bridge `command` or `args` remains.

The final candidate started at `2026-09-07T10:28:13.140Z`: PID **45220**, boot `f257b952-1acd-45f8-a2e0-39d2da95b583`. Both independent fresh Codex clients exited successfully:

| Client | Configuration | Verified calls |
| --- | --- | --- |
| `01a07b69-5454-73e3-8084-8b0d7b6d1849` | Isolated HTTP client overrides | `vscode_list_instances`, `vscode_get_workspace_setup` |
| `01a07b69-db1b-7a92-b6ec-2348b51b6357` | Actual managed user configuration | `vscode_list_instances`, `vscode_get_workspace_setup` |

Both used PID 45220 and the real ready repository instance. Tool-call events completed without an error, and workspace results passed the protocol schema. The two live Codex checks were sequential; simultaneous-client isolation is established separately by the HTTP/process and Extension Host integration tests. Unrelated MCP servers/plugins were disabled only in those ephemeral acceptance clients. No credential was supplied as a process argument or recorded in the report.

At `2026-09-07T10:29:35.720Z`, process inventory showed **one new shared daemon and ten legacy 0.12.0 STDIO processes**. The latter belong to the existing Codex app-server (parent PID 26600); the shared daemon belongs to the scheduler service (parent PID 2496). No executable-name bulk termination occurred. The old session processes are allowed to drain naturally.

After both clients and the installer exited, the final VSIX was installed into the local default VS Code extensions directory. Separate processes at `2026-09-07T10:30:12.505Z` and `2026-09-07T10:32:59.162Z` verified the same daemon PID/boot, `ready`, zero sessions and zero active requests. Windows `AttachConsole` returned `ERROR_INVALID_HANDLE` for that live PID, independently confirming it has no console. The installed executable also passed the GUI-header and native-checksum checks; the final CLI status reported a present login task and current Codex configuration. The existing window was not forcibly reloaded; its 0.12.0 runtime remains compatible, while new/reloaded windows load the installed 0.13.0 extension.

Sanitized local evidence: `formal-migration.json`, `fresh-codex-client.json`, `saved-config-codex-client.json`, `formal-persistence.json`, `formal-config-preservation.json` and `gui-formal-vsix-install.log` in the evidence directory.

## Findings and resolutions

1. **High, resolved — managed comments could enclose another plugin's settings.** The real pre-migration TOML contained the APO plugin table before the bridge end marker. Acceptance comparison detected that the initial marker replacement had dropped its enabled flag. The exact original value was immediately restored outside the comments from the protected backup, and every parsed non-bridge setting was verified equal to the original. Production now rejects update/removal of such a range before service/configuration mutation; both pure configuration and installer regressions cover it. The protected original backup is retained. No other setting was changed by this repair.
2. **High, resolved — MSIX AppData virtualization broke external task launch.** Packaged Codex wrote the logical LocalAppData install into its private cache, while Task Scheduler could not find that executable. Failed attempts rolled back. The formal path now uses the shared user-profile directory, and actual path/task launch regression coverage prevents recurrence.
3. **High, resolved — pinned Bun ignored hidden-console compilation.** API and CLI probes both produced console-subsystem executables. A pre-fix scheduled process also exited with `STATUS_CONTROL_C_EXIT`; the precise source of the console-close event was not established. The upstream [PE writer fix](https://github.com/oven-sh/bun/pull/36292) documents the ignored option. Build-only correction now sets the GUI flag before hashing, recomputes and independently verifies the checksum, and rejects malformed/signed input. Actual console absence and service persistence were verified above.
4. **High, resolved — Bun's repeated pipe bind was unsuitable for locking.** The fixed-version feasibility probe crashed on duplicate binding. The daemon now uses the narrow OS exclusive named-pipe primitive through Bun FFI, with authenticated identity verification and fail-closed occupancy behavior. This adds no third runtime or resident launcher.
5. **Medium, resolved — empty pipe data was confused with disconnection.** Nonblocking `ReadFile` and `ConnectNamedPipe` assign different meanings to `ERROR_NO_DATA`. The native adapter now preserves a connected client awaiting data. Management clients retry only before connection/send; sent commands are never replayed.

## Artifacts and side effects

| Candidate artifact | SHA-256 |
| --- | --- |
| `vscode-agent-bridge-mcp-0.13.0-win32-x64.exe` | `f772d13310f279b19ced1b645a516f1d74b8762d8d7d90051994d7c2901bc022` |
| `vscode-agent-bridge-0.13.0-win32-x64.vsix` | `8e1c82383b39c2720a013520a938a9bebdd37cc19c1bed9ce8e2f62be33fa37c` |
| `vscode-agent-bridge-0.13.0-windows-x64-test-bundle.zip` | `873e59baee1888f95a551ba0020a44086722a771936953fd5723b7511155cf21` |

The versioned formal service, login task, protected HTTP configuration/backup and default-profile VSIX were installed. Prior version files and protected recovery backups remain. Final same-config upgrades needed no new configuration backup; the original migration backup remains available and its ACL was checked. Temporary acceptance tasks/profiles were cleaned by their owning harnesses. Ignored build outputs and evidence remain local. Neither a release tag nor Marketplace publication was created.

## Limits and closure

- **Not executed:** denied access under a second Windows identity. Current-user/SYSTEM DACL inspection and fail-closed publication are not substitutes for this historical security acceptance item.
- **Not executed:** an actual desktop sign-out/sign-in or cross-machine bundle run. The real configured login task was run on demand without disrupting the user's desktop.
- **Bounded tests:** 30-minute session expiry and shutdown deadlines use controlled/shortened clocks in deterministic tests; this is not a long-duration production soak or proof of zero future leaks.
- **Compatibility boundary:** the existing real window kept its 0.12.0 extension runtime; 0.13.0 was installed locally and exercised in isolated installed-VSIX E2E. Reloading existing windows activates it.

Phase 1's implementation, required local gates and formal HTTP/IDE migration are complete within these boundaries. The feature remains on its development branch and is not automatically merged into `master`. Before a later PR/release, apply the repository's current gates; cross-identity and clean-machine acceptance remain explicitly separate. Phase 2 may change extension registration/heartbeat ownership under a new reviewed decision.
