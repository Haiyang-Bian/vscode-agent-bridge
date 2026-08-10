# VS Code Agent Bridge

VS Code Agent Bridge connects local MCP clients such as Codex to IDE-native VS Code state. It has two runtime layers: a standalone STDIO MCP server and a VS Code desktop extension. `packages/protocol` contains their shared RPC contracts and is not a third service.

The unpublished `0.6.0` candidate targets Windows x64 and is distributed as a side-loaded VSIX. It upgrades directly over `0.5.1`; testers do not need Bun, Node.js or this repository because the package contains a Bun-compiled MCP executable and installs a versioned copy only after explicit confirmation.

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
| `vscode_get_workspace_setup` | Inventory trust, onboarding and standard VS Code configuration-file presence without returning contents. |
| `vscode_get_experiment` | Read active experiment lifecycle, health and accepted candidate. |
| `vscode_list_experiments` | Page through ordinary and Managed experiment metadata for one workspace root. |
| `vscode_start_experiment` | Propose and, after workspace onboarding, start an ordinary task-named experiment. |
| `vscode_rename_experiment` | Rename an ordinary experiment with an expected-title concurrency guard. |
| `vscode_create_experiment_checkpoint` | Reconcile the workspace and create an explicit task checkpoint. |
| `vscode_list_experiment_checkpoints` | Read bounded checkpoint history and verification evidence. |
| `vscode_prepare_text_edits` | Validate an expiring, one-use multi-document text Change Set without changing buffers. |
| `vscode_prepare_rename` | Ask the fixed VS Code rename provider for a text-only Change Set. |
| `vscode_apply_change_set` | Revalidate versions and hashes, then atomically apply text edits to dirty buffers. |
| `vscode_record_experiment_evidence` | Attach explicitly client-reported test, build or lint evidence. |
| `vscode_save_document` | Save one guarded existing file document and capture the final format/code-action-on-save text. |
| `vscode_format_document` | Apply edits from the fixed VS Code formatting provider while leaving the buffer dirty. |
| `vscode_list_code_actions` | List expiring Code Action handles without exposing command arguments. |
| `vscode_apply_code_action` | Apply a one-use pure-text Code Action after revalidating every target. |
| `vscode_list_terminals` | Read terminal lifecycle, PID, activity and explicit capture coverage. |
| `vscode_list_terminal_executions` | Page through Shell Integration executions observed since extension activation. |
| `vscode_read_terminal_output` | Page through bounded, sanitized in-memory output with loss metadata. |

The original read tools and experiment-history tools are read-only. Every document write requires an active trusted local experiment, explicit `instanceId`/`sessionId`, and fresh document version plus SHA-256 guards. Starting is the sole write without a session ID and requires an explicit instance, root, title, reason and user-confirmed workspace onboarding. There is no generic VS Code command, terminal input, shell, filesystem or Git tool.

## Agent policies

Run **Configure Agent Policies**, then rerun **Configure Codex** whenever a policy changes.

- `autonomous` (default) allows guarded IDE edits, formatting, pure-text Code Actions and saves without per-tool prompts.
- `review` asks Codex for write approval and requires an explicitly accepted checkpoint before Finalize.
- `readOnly` removes write tools from the managed Codex block and makes extension handlers reject writes even if the block is stale.
- Terminal read policy `allow` exposes captured command lines/output only in trusted local workspaces; `metadataOnly` exposes lifecycle metadata; `deny` rejects all terminal tools.

## Recoverable experiments

The first experiment request in a trusted local workspace inventories `.vscode`, `settings.json`, `launch.json`, `tasks.json` and the workspace file, then asks before enabling experiments. Confirmation writes only `vscodeAgentBridge.experiments.enabled` and the selected `agentEditVisibility` through the VS Code Configuration API; cancellation makes no file change. Existing JSONC content is preserved and launch/tasks/workspace files are never modified.

After onboarding, the Agent can name an ordinary experiment for the current task, list sessions, rename ordinary sessions and create explicit checkpoints. Accept, restore, Finalize, abandon, pin, delete and every Managed Worktree action remain user-only. Experiments keep content-addressed, gzip-compressed text snapshots in VS Code extension storage, separate from the repository and Settings Sync.

- Saving is not acceptance; a checkpoint is not a Git commit.
- In autonomous mode the Agent may save an existing guarded document; it cannot create files or save untitled buffers.
- Restore creates a safety checkpoint and restores only editor buffers; it never saves.
- In autonomous mode Finalize may use the current saved state when no candidate is accepted. An existing accepted candidate stays authoritative. Review mode always requires acceptance.
- Resource creation, deletion and rename are observed, but v0.3 whole-session restore refuses those cases.
- Retention defaults to 30 days or 500 MB. Active, pinned and corrupt sessions are not auto-deleted.

The default Git workflow is an ordinary experiment branch plus normal Git squash/rebase performed by the user. Automatic checkpoints never create Git commits.

Agent writes appear in the native **Agent Activity** view and status bar. Depending on `agentEditVisibility`, guarded target documents are opened as fixed tabs before mutation; the default opens all targets and focuses the first. Activity is memory-only, capped at 200 entries, and records relative names and outcomes rather than source, replacement text, hashes, terminal data or absolute paths.

## Managed worktrees and one-commit promotion (advanced)

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

No PAT is stored in this repository. See the [v0.6.0 release checklist](docs/releases/v0.6.0.md) and [v0.6.0 cross-machine acceptance prompt](docs/acceptance/v0.6.0-windows-x64.md).

## Security and license

The extension uses a per-window random identifier and token over local IPC. Descriptor files are atomically replaced and live-probed. Codex configuration changes are marker-scoped, TOML-validated, backed up and atomically replaced. Experiment content never appears in Doctor output.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). This project is licensed under the [MIT License](LICENSE).
