# Change Log

## 0.12.0 - 2026-08-11

- Upgraded to Bridge protocol v11 and exactly 64 catalog-derived tools.
- Added experiment-scoped prepared and independently persisted Shell/Process Task and Debug adapter definitions with complete fingerprints, execution previews and provenance.
- Correlated Task/Debug prepare, start, terminal/output, exit and final checkpoint in Agent Activity while excluding environment values.
- Added canonical real-path/reparse protection and exact, expiring provider-derived grants for external language-service results.
- Changed extension-setting reads to hash/type/scope/risk only and made Global Profile updates a serialized pending/apply/commit journal with startup recovery and Doctor attention.
- Restored `initializing` descriptor publication before storage recovery, separated Doctor health dimensions and retained old descriptors as sanitized incompatible instances.
- Hardened Windows registry descriptors to the current SID plus SYSTEM with fixed no-shell identity/ACL commands and fail-closed fsync/atomic publication.
- Added 1 MiB Usage Insight rotation, recurring prune, strict 20 MiB append capacity, shutdown flush, actionable default Output ordering and typed catalog-complete MCP registration.

## 0.11.0 - 2026-08-10

- Added two bounded extension-integration tools, raising the catalog to 60 tools on protocol v10.
- Added a static reviewed adapter catalog; listing adapters never activates an extension and arbitrary extension IDs, commands, exports or arguments are unavailable.
- Added the first production adapter for the official `ms-python.python` extension through Microsoft's pinned `@vscode/python-extension` facade.
- Added bounded active-environment state containing only interpreter path, environment type/name, Python version and bitness.
- Added fail-closed handling for missing, version-incompatible, activation-failed and API-incompatible extensions plus unit, STDIO and real Extension Host coverage.

## 0.10.0 - 2026-08-10

- Added five bounded Marketplace and current-Profile tools, raising the catalog to 58 tools on protocol v9.
- Added a fixed Visual Studio Marketplace Gallery client with TLS/proxy support, strict bounded response validation, 15-minute caching and fail-closed errors.
- Added deterministic ranking that separates a versioned official-maintainer directory from Marketplace Verified Publisher state.
- Added exact-version, one-use installation plans with a completely resolved maximum-20 dependency graph and no downgrade/update/uninstall path.
- Added native VS Code installation with Publisher Trust/reload preservation and no CLI, URL or arbitrary VSIX fallback.
- Added manifest-declared, non-sensitive current-Profile configuration with canonical hash preconditions, target-scope validation and no private Profile storage access.
- Added a 30-day/100-entry local Global Profile undo journal, experiment checkpoints for Workspace/Folder changes and native Profile-management commands.
- Added unit, source-boundary and real Extension Host coverage for malformed Marketplace responses, version drift, stale configuration and undo.

## 0.9.0 - 2026-08-10

- Added nine read-only extension and IDE-signal tools, raising the catalog to 53 tools on protocol v8.
- Added installed-extension and manifest-contribution reflection without activation, exports access or contributed-command execution.
- Added stable-API Profile coverage reporting without private Profile storage access.
- Added a 15-minute, 2,000-event in-memory Problems summary timeline without diagnostic-body persistence.
- Added coverage-aware Output source discovery and bounded reads of already opened Output documents without channel switching or private log access.
- Added bounded, sanitized, since-activation Debug Console capture with telemetry filtering, relative source positions and explicit data-loss metadata.
- Extended Overview and real Extension Host E2E with extension, Problems, visible Output and Debug Console evidence.

## 0.8.0 - 2026-08-10

- Renamed the stable Activity Bar container to VS Code Agent Bridge and added native Overview, Capabilities and Usage Insights views alongside Experiments and Agent Activity.
- Added an authoritative 44-tool catalog that derives tool names and classifies intent, side effects, experiment requirements, recoverability, open-world effects, sensitivity and MCP annotations.
- Added `vscode_get_bridge_capabilities` and `vscode_get_usage_insights`.
- Added per-process append-only local insight events with 30-day/20 MiB retention and no parameters, results, paths, source, terminal data, debug values, environment variables or credentials.
- Added explicit clear and aggregate-export commands plus deterministic, count-backed friction and workflow-closure suggestions.
- Removed protocol/tool-count literals from Extension Host and packaged E2E completion markers.

## 0.7.0 - 2026-08-10

- Upgraded the authenticated bridge to protocol v6 with exactly 42 bounded IDE workflow tools.
- Replaced per-capability extension policy with a machine master switch, explicit/aggressive execution modes and an explicit migration gate for restrictive v0.6 selections.
- Added comment-preserving JSONC reads and guarded JSON Pointer updates for settings, launch, tasks and workspace configuration.
- Added one-use, hash-guarded text resource creation, rename and deletion plus schema-v2 resource snapshots and disk restoration.
- Added fingerprinted VS Code Task enumeration, execution, termination, lifecycle tracking and terminal-coverage correlation without arbitrary command input.
- Added named static Debug launch, bounded thread/stack/scope/variable reads, fixed controls, source/function breakpoints, evaluate and setVariable through a strict DAP whitelist.
- Extended Activity and Doctor while excluding source, Task commands/output, Debug expressions/values, DAP messages, credentials and absolute paths.
- Added real Extension Host coverage for JSONC policy, resource recovery, Tasks, an isolated inline Debug Adapter, master-switch restart and the Managed Worktree regression.

## 0.6.1 - 2026-08-10

- Propagated MCP cancellation through authenticated bridge requests so an abandoned onboarding prompt cannot later commit workspace settings.
- Added explicit `initializing`, `ready` and `degraded` instance lifecycle states and registered the bridge before experiment recovery.
- Increased only interactive write RPCs to a bounded 90-second timeout while retaining prompt cancellation and one active request per socket.
- Excluded Git-ignored build output from future external-change checkpoints while retaining open-buffer observation and conservative fallback on Git failures.
- Deduplicated content-addressed blob validation during recovery and added delayed-activation/onboarding regression coverage.
- Serialized all per-session manifest mutations so automatic checkpoints and diagnostic evidence cannot revert a concurrent experiment rename or lose another metadata update.

## 0.6.0 - 2026-08-10

- Upgraded the authenticated bridge to protocol v5 with 26 bounded IDE tools.
- Added first-use per-root experiment onboarding through the VS Code Configuration API and read-only setup inventory for `.vscode`, settings, launch, tasks and workspace files.
- Added Agent tools to list, start, rename and checkpoint ordinary experiments while preserving user-only acceptance, recovery, lifecycle and Managed Worktree control.
- Added expected-title concurrency protection and atomic ordinary-session rename without migrating existing experiment storage.
- Added the memory-only Agent Activity view, operation status bar and four configurable fixed-tab visibility policies for guarded writes.
- Extended real Extension Host coverage through empty `.vscode` onboarding, task naming, stale rename refusal, explicit checkpoints, multi-file tab visibility and the v0.5/v0.4 regression suites.

## 0.5.1 - 2026-08-09

- Treat formatter responses with zero edits as successful no-ops instead of reporting `FORMAT_PROVIDER_UNAVAILABLE`.
- Added a default-off deterministic pure-text Code Action fixture for positive acceptance testing.

## 0.5.0 - 2026-08-09

- Added autonomous, review and read-only machine profiles with extension-side enforcement and policy-aware Codex configuration.
- Added guarded save, fixed-provider formatting and expiring pure-text Code Action tools for existing experiment documents.
- Added read-only terminal metadata, Shell Integration execution and sanitized output tools with explicit coverage and memory limits.
- Added autonomous Finalize from current saved state while preserving accepted-candidate precedence and review-mode acceptance.
- Positioned ordinary experiment branches plus user-controlled Git squash as the default and managed worktrees as an advanced mode.
- Extended real Extension Host coverage through format-on-save, Code Actions, terminal output pagination, policy transitions and v0.4 promotion regression.

## 0.4.0 - 2026-08-09

- Added user-created, locked managed Git worktrees with private experiment branches.
- Added fixed `execFile` Git boundaries, repository/worktree validation and no remote/config operations.
- Added user-only private checkpoint commits that preserve normal hooks and signing.
- Added explicit target-drift refusal and sync/rebase preview, continue and abort flows.
- Added accepted-commit validation and one-commit promotion with parent/tree invariants and guarded cherry-pick recovery.
- Added explicit abandon, exact-path cleanup, optional force confirmation, expected-old-SHA branch deletion and repair reports.
- Added temporary-repository boundary tests and real two-window E2E proving ten private commits become one target commit after explicit sync.

## 0.3.0 - 2026-08-09

- Added recoverable local Agent experiments with content-addressed snapshots, immutable events, leases, retention and crash recovery.
- Added native history, evidence, snapshot diffs, accepted candidates, guarded restore, pinning, deletion and Finalize without Git commits.
- Added expiring, one-use text Change Sets with version plus SHA-256 preconditions and atomic multi-document application.
- Added text-only rename through the fixed VS Code provider; resource operations remain forbidden.
- Added six MCP tools for experiments, Change Sets and explicitly client-reported evidence.
- Added protocol v3 hashes/timestamps, stable experiment errors, Doctor storage summaries and trusted-workspace enforcement.
- Extended real Extension Host tests through stale all-or-nothing rejection, rename, evidence, restore and Finalize while verifying Git HEAD is unchanged.

## 0.2.0 - 2026-08-09

- Added a Bun-compiled Windows x64 baseline MCP executable bundled in the platform VSIX.
- Added one-command, confirmed Codex configuration with TOML validation, timestamped backup, atomic replacement, conflict refusal, upgrade detection and marker-scoped removal.
- Added `vscode_read_document`, `vscode_get_diagnostics`, `vscode_get_document_symbols`, `vscode_get_definitions`, `vscode_get_references` and `vscode_get_hover`.
- Upgraded the internal authenticated bridge protocol to v2 with bounded results, stable errors and normalized IDE data.
- Added live instance probing, stale descriptor cleanup, atomic descriptor writes, remote-host rejection and Doctor.
- Added real Extension Host E2E, standalone EXE/VSIX smoke tests, content auditing, checksums and GitHub release automation.
- Changed the project license to MIT.
