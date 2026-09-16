# Phase 2 direct IDE Bridge acceptance

- Date: 2026-09-16
- Overall status: `completed_with_findings`
- Scope: protocol v12 direct IDE runtime, two-view extension UI, HTTP capacity behavior, bounded service version retention, packaged Windows artifacts and formal local migration
- Environment: Windows x64, VS Code 1.137.0, pinned Bun 1.3.11
- Implementation head before this report: `86965d3ef9f5aa3aa4834262dbb32f6c2663b8bd`

## Delivered commits

| Commit | Scope |
| --- | --- |
| `67d6ef3` | ADR 0023 and direct Bridge decision |
| `02e045e` | Protocol v12, 57 direct tools, extension/UI convergence and correlated capacity errors |
| `addef25` | Current plus verified rollback service-version retention |
| `c3ccd9b` | Current documentation, migration guidance and v0.14 acceptance procedure |
| `8f1d713` | Release and artifact boundary coverage |
| `9bc2117` | Public instance metadata E2E assertion |
| `86965d3` | Observable reload/open/close lifecycle fixture |

## Result matrix

| Boundary | Result | Evidence |
| --- | --- | --- |
| Impact classification | Pass | `master..HEAD` classified `full`; all three workspaces, all eight E2E scenarios, repeat E2E and artifact gate required |
| Complete fast gate | Pass | Protocol/MCP/extension type checks and builds; 161/161 tests across 41 files |
| MCP contracts | Pass | Exactly 57 names; deleted experiment tools absent; direct schemas omit experiment/session fields; prepared handles retain binding and one-use checks |
| Capacity and isolation | Pass | Real MCP SDK clients receive correlated JSON-RPC `-32002` / `SERVER_CAPACITY_REACHED`; admitted work finishes and other clients remain usable |
| Process ownership | Pass | Twenty concurrent compiled-EXE launches share one authenticated daemon; crash, port conflict and occupied singleton tests pass |
| Extension Host | Pass | Two complete isolated runs of all eight scenarios; direct mutation, focus preservation, Task/Debug, compatibility and cleanup pass |
| UI/product surface | Pass | Manifest exposes only Status and Agent Activity; legacy experiment settings/tools/views are absent |
| Installer | Pass | Actual isolated login task install, idempotence, successful version pruning, failed-candidate rollback, restart and uninstall pass |
| Window lifecycle | Pass | Same daemon survives initialization, real reload, two windows, explicit routing and both window exits |
| Packaged product | Pass | Hidden-console EXE, VSIX audit, installed-VSIX HTTP E2E and artifact smoke gate pass |
| Formal local migration | Pass | Service upgraded from 0.13.0/v11 PID 7380 to 0.14.0/v12 PID 40240; login task present and managed Codex configuration current |
| Real Codex client | Pass | Fresh Codex CLI used only `vscode_list_instances`, `vscode_read_document`, `vscode_prepare_text_edits` and `vscode_apply_change_set`; isolated marker was read back successfully |
| Cross-user/cross-machine ACL | Not run | Current-user and SYSTEM ACL checks pass; another Windows identity remains a separate acceptance requirement |

## Artifact and installation evidence

| Artifact | SHA-256 |
| --- | --- |
| `vscode-agent-bridge-mcp-0.14.0-win32-x64.exe` | `fbc485477627ea5961e4ff31d0f753c1fec5b4ee09f555c1d3615cbb65b5f97a` |
| `vscode-agent-bridge-0.14.0-win32-x64.vsix` | `a18645e4bd4d5e3b89163ec8ecb49596cfde11b6015a9b9480bb83960d2d5478` |

The formal service version directory contains exactly the current `0.14.0/fbc485477627ea59` executable and the retained `0.13.0/f772d13310f279b1` rollback executable. The installed extension reports `AliceLin.vscode-agent-bridge@0.14.0`. No Marketplace publication, release tag or formal GitHub release was created.

The current project window published protocol v12, release `0.14.0`, `compatibility: current` and `releaseAlignment: current`. A separate still-open `0.12.0`/v11 window remained visible as `compatibility: incompatible` and `releaseAlignment: older`; it was not terminated or reloaded. The fresh Codex acceptance client modified only the ignored fixture `artifacts/phase2-live-fixture/codex-bridge-fixture.ts` and returned `markerVerified: true`.

## Findings and resolutions

1. The first complete E2E attempt failed because the test compared the public instance object for exact equality after release alignment was added. The runtime returned correct additional public metadata. The assertion now checks the selected instance and the two intended fields; the focused scenario and two complete E2E runs passed.
2. The first artifact attempt found that VS Code may reject reload/open/close command promises with `Canceled` after the window transition has already begun. The lifecycle harness now treats only this command result as provisional and verifies the actual transition through process/descriptor markers. The focused lifecycle check, artifact gate and repeated full E2E passed afterward.
3. Fresh Codex startup logged failures for unrelated stale MCP endpoints and fallback model metadata. The `vscode_agent_bridge` server initialized and all requested Bridge calls completed. These warnings are outside this product acceptance.
4. A v11 window remains active by design. Its continued presence is compatibility evidence, not a second 0.14 daemon and not a migration failure.

## Side effects and retained state

- Installed the 0.14.0 VSIX in the current VS Code user profile and opened this repository in a new VS Code window.
- Upgraded the formal per-user service and login task; the daemon remains running at PID 40240.
- Updated the managed Codex HTTP block and created a protected backup under `<HOME>\.codex`.
- Retained one verified 0.13.0 rollback executable and removed other stale formal version directories.
- Generated ignored build/evidence artifacts under `artifacts/phase2-evidence` and the isolated live fixture under `artifacts/phase2-live-fixture`.
- Left the unrelated v11 VS Code window and all user Git branches/worktrees untouched.

## Evidence boundary and closure

This report establishes local same-user Windows x64 acceptance for phase 2. It does not establish another-user ACL denial, a different-machine result, Marketplace readiness or a published release. Those claims require the separate v0.14 acceptance procedure.

The requested phase is locally complete when this report and its index entry are committed, the branch is clean, and the formal daemon remains healthy with current managed configuration. PR creation and merge are intentionally deferred because the user requested implementation on the new phase branch, not automatic integration into `master`.
