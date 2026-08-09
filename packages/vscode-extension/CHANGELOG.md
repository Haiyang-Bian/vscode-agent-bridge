# Change Log

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
