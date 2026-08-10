# VS Code Agent Bridge

VS Code Agent Bridge connects local MCP clients such as Codex to IDE-native VS Code state. It has two runtime layers: a standalone STDIO MCP server and a VS Code desktop extension. `packages/protocol` contains their shared RPC contracts and is not a third service.

The unpublished `0.7.0` candidate targets Windows x64 and is distributed as a side-loaded VSIX. It upgrades directly over `0.6.1`; testers do not need Bun, Node.js or this repository because the package contains a Bun-compiled MCP executable and installs a versioned copy only after explicit confirmation.

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
| `vscode_apply_change_set` | Revalidate versions, hashes and resource state, then apply a one-use text/resource Change Set. |
| `vscode_record_experiment_evidence` | Attach explicitly client-reported test, build or lint evidence. |
| `vscode_save_document` | Save one guarded existing file document and capture the final format/code-action-on-save text. |
| `vscode_format_document` | Apply edits from the fixed VS Code formatting provider while leaving the buffer dirty. |
| `vscode_list_code_actions` | List expiring Code Action handles without exposing command arguments. |
| `vscode_apply_code_action` | Apply a one-use pure-text Code Action after revalidating every target. |
| `vscode_list_terminals` | Read terminal lifecycle, PID, activity and explicit capture coverage. |
| `vscode_list_terminal_executions` | Page through Shell Integration executions observed since extension activation. |
| `vscode_read_terminal_output` | Page through bounded, sanitized in-memory output with loss metadata. |
| `vscode_get_workspace_configuration` | Read bounded settings, launch, tasks or workspace JSONC with hashes and parse diagnostics. |
| `vscode_update_workspace_configuration` | Apply guarded JSON Pointer updates while preserving JSONC comments and unrelated fields. |
| `vscode_prepare_resource_changes` | Prepare bounded creation, rename or deletion of in-root text files and directories. |
| `vscode_list_tasks` | List workspace-scoped VS Code Tasks with stable IDs and fingerprints. |
| `vscode_run_task` | Run a previously listed, fingerprint-matched Task inside the active experiment. |
| `vscode_list_task_executions` | Page through bounded in-memory Task lifecycle and terminal-coverage metadata. |
| `vscode_terminate_task` | Terminate one active Task execution. |
| `vscode_list_debug_configurations` | List static launch configurations and compounds without exposing raw command objects. |
| `vscode_start_debug_session` | Start a named, fingerprint-matched launch configuration or compound. |
| `vscode_list_debug_sessions` | List active and recently ended tracked debug sessions. |
| `vscode_get_debug_state` | Page through bounded threads, stack frames, scopes and variables. |
| `vscode_control_debug_session` | Invoke one fixed pause/continue/step/restart/terminate action. |
| `vscode_list_breakpoints` | List workspace source and function breakpoints. |
| `vscode_update_breakpoints` | Replace guarded source/function breakpoints with workspace scope checks. |
| `vscode_evaluate_debug_expression` | Evaluate within an explicit tracked session/frame/context without retaining the expression. |
| `vscode_set_debug_variable` | Set one variable through a current variables reference without retaining its value. |

The original read tools and experiment-history tools remain read-only. Every mutation requires an active trusted local experiment, explicit instance/session routing, root scope and the relevant version, hash, fingerprint or revision precondition. Starting is the sole write without a session ID and still requires an explicit instance, root, title, reason and user-confirmed workspace onboarding. There is no generic VS Code command, arbitrary DAP request, terminal input, shell, unrestricted filesystem or Agent-callable Git tool.

## Bridge controls

Run **Configure Bridge** to choose the machine-level master switch and workflow mode, then rerun **Configure Codex** after upgrading the MCP executable.

- `vscodeAgentBridge.enabled` defaults to `true`. Turning it off closes RPC connections and removes the instance descriptor; local Doctor and configuration commands remain available.
- `explicit` (default) permits only workflows explicitly requested through MCP and rejects delayed execution such as `runOn: folderOpen`.
- `aggressive` also permits bounded deferred IDE configuration and reports `deferredEffects` in results, Doctor and Activity.
- Existing v0.6 users who explicitly selected `readOnly`, `review`, `metadataOnly` or `deny` are not silently widened: bridge publication pauses until they explicitly enable or disable v0.7.

The managed Codex block no longer chooses approval modes. Codex, user configuration or a supervising Agent decides approval from the accurate MCP annotations.

## Recoverable experiments

The first experiment request in a trusted local workspace inventories `.vscode`, `settings.json`, `launch.json`, `tasks.json` and the workspace file, then asks before enabling experiments. Confirmation writes only `vscodeAgentBridge.experiments.enabled` and the selected `agentEditVisibility` through the VS Code Configuration API; cancellation makes no file change. Existing JSONC content is preserved and launch/tasks/workspace files are never modified.

After onboarding, the Agent can name an ordinary experiment for the current task, list sessions, rename ordinary sessions and create explicit checkpoints. Accept, restore, Finalize, abandon, pin, delete and every Managed Worktree action remain user-only. Experiments keep content-addressed, gzip-compressed text snapshots in VS Code extension storage, separate from the repository and Settings Sync.

- Saving is not acceptance; a checkpoint is not a Git commit.
- The Agent may save guarded existing documents and prepare bounded text-file/directory creation, rename and deletion inside a schema-v2 experiment. Untitled and binary resource creation remain unsupported.
- Restore creates a safety checkpoint, reconstructs captured text/resource state on disk, saves affected buffers and enters recovery-required state if a rollback cannot complete. Legacy schema-v1 sessions retain their older text-only boundary.
- Finalize may use the current saved state when no candidate is accepted. An existing accepted candidate stays authoritative.
- Task and Debug checkpoints capture recoverable workspace text/resources only. External processes, services, databases, network effects, environment changes and Git history are explicitly outside rollback coverage.
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

No PAT is stored in this repository. See the [v0.7.0 release checklist](docs/releases/v0.7.0.md) and [v0.7.0 cross-machine acceptance procedure](docs/acceptance/v0.7.0-windows-x64.md). Earlier self-bootstrap findings remain available under [docs/audits](docs/audits/README.md).

## Security and license

The extension uses a per-window random identifier and token over local IPC. Descriptor files are atomically replaced and live-probed. Codex configuration changes are marker-scoped, TOML-validated, backed up and atomically replaced. Experiment content never appears in Doctor output.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). This project is licensed under the [MIT License](LICENSE).
