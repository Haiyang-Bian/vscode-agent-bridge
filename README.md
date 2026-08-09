# VS Code Agent Bridge

VS Code Agent Bridge connects local MCP clients such as Codex to IDE-native VS Code state. It has two runtime layers: a standalone STDIO MCP server and a VS Code desktop extension. `packages/protocol` contains their shared RPC contracts and is not a third service.

The unpublished `0.4.0` candidate targets Windows x64 and is distributed as a side-loaded VSIX. Testers do not need Bun, Node.js or this repository: the package contains a Bun-compiled MCP executable and installs a versioned copy only after explicit confirmation.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `vscode_list_instances` | Discover live local VS Code windows without exposing credentials or IPC endpoints. |
| `vscode_get_editor_context` | Read editor, selection, dirty state, document version, trust and workspace context. |
| `vscode_read_document` | Read a VS Code buffer, including unsaved content, with bounds and truncation metadata. |
| `vscode_get_diagnostics` | Read normalized active-document, document or workspace diagnostics. |
| `vscode_get_document_symbols` | Read a flattened symbol tree with stable hierarchy fields. |
| `vscode_get_definitions` | Resolve definitions for an explicit URI and zero-based position. |
| `vscode_get_references` | Resolve sorted, deduplicated references. |
| `vscode_get_hover` | Read bounded hover text with command links redacted. |
| `vscode_get_experiment` | Read active experiment lifecycle, health and accepted candidate. |
| `vscode_list_experiment_checkpoints` | Read bounded checkpoint history and verification evidence. |
| `vscode_prepare_text_edits` | Validate an expiring, one-use multi-document text Change Set without changing buffers. |
| `vscode_prepare_rename` | Ask the fixed VS Code rename provider for a text-only Change Set. |
| `vscode_apply_change_set` | Revalidate versions and hashes, then atomically apply text edits to dirty buffers. |
| `vscode_record_experiment_evidence` | Attach explicitly client-reported test, build or lint evidence. |

The original read tools and experiment-history tools are read-only. Preparing a Change Set is side-effect-free but non-idempotent because it issues a short-lived capability. Applying and recording evidence require Codex write approval plus explicit `instanceId` and `sessionId`. There is no generic VS Code command, terminal, filesystem or Git tool.

## Recoverable experiments

Run **VS Code Agent Bridge: Start Agent Experiment** in a trusted local workspace before asking an Agent to edit. Experiments keep content-addressed, gzip-compressed text snapshots in VS Code extension storage, separate from the repository and Settings Sync. Agent Apply, manual edits, saves, external changes, explicit checkpoints and Git HEAD changes remain distinct events.

- Saving is not acceptance; a checkpoint is not a Git commit.
- Agent changes remain dirty until the user saves them.
- Restore creates a safety checkpoint and restores only editor buffers; it never saves.
- Finalize requires saved current content to match the accepted checkpoint and never stages or commits.
- Resource creation, deletion and rename are observed, but v0.3 whole-session restore refuses those cases.
- Retention defaults to 30 days or 500 MB. Active, pinned and corrupt sessions are not auto-deleted.

## Managed worktrees and one-commit promotion

Run **Start Managed Worktree Experiment** from a clean, named local Git branch to isolate saved files and private trial commits. The extension creates and locks a private worktree under `%LOCALAPPDATA%/VSCodeAgentBridge/worktrees`, opens it in a new window and reuses the v0.3 checkpoint timeline.

- Git runs only through fixed `execFile` operations; no Git capability is exposed through MCP.
- **Create Private Checkpoint Commit** stages and commits only after explicit user action and preserves normal hooks/signing.
- A promotable candidate must be a user-accepted commit reachable on the private branch.
- Target drift returns `TARGET_MOVED`. **Sync Managed Experiment** is a separate confirmed rebase with continue/abort commands.
- Finalize runs from the clean original target window, creates one commit whose only parent is the current target HEAD, and verifies its tree equals the accepted commit tree.
- Promotion never pushes or deletes the worktree/private branch. Cleanup is a separate, exact-path, confirmed operation with old-SHA ref protection.
- Worktrees are never removed by snapshot retention or age limits.

## Repository layout

```text
packages/
  protocol/          RPC schemas, error codes and discovery contracts
  mcp-server/        standalone STDIO MCP server launched by Codex
  vscode-extension/  VS Code desktop UI extension and installer
scripts/             Bun build, test, package and release verification
docs/adr/            architecture and security decisions
docs/acceptance/     clean-machine Windows acceptance procedures
```

## Development

Install Bun 1.3.11 and Node.js 22 or newer. Node is used only by Microsoft's official `vsce`; Bun owns dependency installation, workspace builds and tests.

```powershell
bun install --frozen-lockfile
bun run check
bun run test:e2e
bun run package:vsix
bun run release:checksums
bun run package:test-bundle
bun run test:artifact
```

`bun run check` performs type checking, Bun unit/contract tests and workspace builds. `test:e2e` runs an isolated real VS Code Extension Host. `package:vsix` compiles the Windows x64 baseline EXE, packages a platform VSIX and audits its contents. Generated release files are written to `artifacts/`.

## Release

Pull requests and `master` run [CI](.github/workflows/ci.yml). A version tag runs [the release workflow](.github/workflows/release.yml), creates checksums, a version-specific cross-machine test bundle and provenance, and publishes a GitHub Release. Marketplace publishing remains disabled and runs through `vsce --oidc` only if `MARKETPLACE_TRUSTED_PUBLISHING_ENABLED` is explicitly set to `true`.

No PAT is stored in this repository. See the [v0.4 release checklist](docs/releases/v0.4.0.md) and [v0.4 cross-machine acceptance prompt](docs/acceptance/v0.4.0-windows-x64.md).

## Security and license

The extension uses a per-window random identifier and token over local IPC. Descriptor files are atomically replaced and live-probed. Codex configuration changes are marker-scoped, TOML-validated, backed up and atomically replaced. Experiment content never appears in Doctor output.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). This project is licensed under the [MIT License](LICENSE).
