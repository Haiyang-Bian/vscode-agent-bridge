# VS Code Agent Bridge

VS Code Agent Bridge connects local MCP clients such as Codex to IDE-native VS Code state. It has two runtime layers: one per-user Streamable HTTP MCP daemon and one extension runtime in each VS Code window. `packages/protocol` is their shared contract library, not a third service.

The unpublished `0.14.0` Windows x64 candidate uses extension RPC protocol v12 and exposes exactly 57 catalog-derived tools. Protocol v12 deliberately removes experiments and Managed Worktree orchestration. A client selects a live `instanceId` and local `rootUri`, then calls bounded IDE capabilities directly. Existing v11 windows remain discoverable as incompatible and are never selected for v12 calls.

The product is most useful where VS Code has authoritative state: unsaved buffers, diagnostics and language providers, current terminal/Task/Debug state, extension metadata, native configuration, and user-visible activity. It is not a general filesystem, shell, Git or arbitrary VS Code command interface.

## Tool surface

The authoritative list and annotations live in `packages/protocol/src/tool-catalog.ts`. The 57 names are grouped as follows:

- Context and extension ecosystem (18): `vscode_list_instances`, `vscode_get_editor_context`, `vscode_get_workspace_setup`, `vscode_get_workspace_configuration`, `vscode_get_bridge_capabilities`, `vscode_get_usage_insights`, `vscode_list_extensions`, `vscode_get_extension_details`, `vscode_get_extension_configuration_schema`, `vscode_get_profile_context`, `vscode_list_output_sources`, `vscode_read_visible_output`, `vscode_search_extensions`, `vscode_prepare_extension_install`, `vscode_apply_extension_install`, `vscode_get_extension_configuration`, `vscode_list_extension_integrations`, `vscode_get_extension_integration_state`.
- Language intelligence (6): `vscode_get_diagnostics`, `vscode_get_document_symbols`, `vscode_get_definitions`, `vscode_get_references`, `vscode_get_hover`, `vscode_list_diagnostic_events`.
- Editing and configuration (11): `vscode_update_workspace_configuration`, `vscode_read_document`, `vscode_prepare_text_edits`, `vscode_prepare_rename`, `vscode_prepare_resource_changes`, `vscode_apply_change_set`, `vscode_save_document`, `vscode_format_document`, `vscode_list_code_actions`, `vscode_apply_code_action`, `vscode_update_extension_configuration`.
- Terminals (3): `vscode_list_terminals`, `vscode_list_terminal_executions`, `vscode_read_terminal_output`.
- Tasks (6): `vscode_list_tasks`, `vscode_prepare_task`, `vscode_persist_task`, `vscode_run_task`, `vscode_list_task_executions`, `vscode_terminate_task`.
- Debug (13): `vscode_list_debug_configurations`, `vscode_prepare_debug_configuration`, `vscode_persist_debug_configuration`, `vscode_start_debug_session`, `vscode_list_debug_sessions`, `vscode_get_debug_state`, `vscode_control_debug_session`, `vscode_list_breakpoints`, `vscode_update_breakpoints`, `vscode_evaluate_debug_expression`, `vscode_set_debug_variable`, `vscode_list_debug_output`, `vscode_read_debug_output`.

Calls no longer accept `sessionId`, experiment titles, experiment reasons or checkpoint identifiers. Mutations revalidate workspace trust, the selected local root, document versions and SHA-256 hashes, resource existence, configuration hashes, or Task/Debug fingerprints as applicable. Short-lived one-use handles remain for prepared change sets, extension installation plans, Tasks and Debug configurations because they bind reviewed candidates to exact state; they do not create a global session.

Task and Debug definitions execute only through fixed VS Code APIs and retain their visible IDE lifecycle. The Bridge does not expose terminal input, arbitrary `vscode.commands.executeCommand`, unrestricted Debug Adapter requests, general filesystem operations or Agent-callable Git operations. Recovery claims are precise: Global Profile configuration has its own bounded undo journal; successful workspace writes do not promise durable snapshot restoration.

## Shared service

Codex connects to one authenticated daemon at a persisted `127.0.0.1` port and `/mcp`. The daemon starts with the current user's login task and remains ready when no VS Code window exists. A stable named pipe owns the per-user singleton, while each MCP client has independent protocol and cancellation state.

The server limits the current installation to 128 sessions, 8 active requests per session and 64 active requests globally. A parsed JSON-RPC request that exceeds capacity receives HTTP 200 with the same request ID, JSON-RPC error `-32002`, and `data.bridgeCode = "SERVER_CAPACITY_REACHED"`. Authentication, Host and Origin failures remain HTTP transport rejections.

See [installation and recovery](docs/installation.md) for the installer, login task, rollback and isolated acceptance flow.

## VS Code UI

The Activity Bar contains two views:

- **Status** shows service and Codex configuration health, publication, protocol and release alignment, trust, Problems, Task/Debug/terminal summaries, local insight controls and Doctor actions.
- **Agent Activity** shows side-effecting operations, running Task/Debug work and failures. Ordinary reads are omitted. Entries retain an internal target while displaying redacted text; VS Code opens or reveals a target only when the user clicks the entry.

Agent operations do not open files, switch editors or steal focus. A failure to render optional UI cannot block the underlying operation. When stable VS Code APIs do not expose the current Profile name or an output source, Status reports that the API does not provide it.

Version 0.14.0 never loads old experiment storage. If Bridge-owned legacy metadata is present, Status offers commands to open its location or delete it after a second confirmation. The cleanup is limited to extension metadata and snapshots; Git branches and worktrees remain ordinary user-managed Git state.

Local usage insights remain privacy-preserving aggregates. They contain tool/category, outcome, timing and size buckets, truncation and stable errors, never parameters, results, paths, source, hashes, terminal content, debug values, environment data or credentials. Export and clear actions remain in Status and the Command Palette.

## Installation

Install the side-loaded VSIX, then run **VS Code Agent Bridge: Configure Codex**. The VSIX contains the compiled MCP executable, so testers do not need Bun, Node.js or this repository. **Run Doctor** checks the authenticated daemon, login task, managed Codex block, executable integrity, extension publication, protocol/release status and legacy-data notice without printing secrets or internal endpoints.

The installer stages and self-tests a version/hash-specific executable before switching the task. After the new daemon is healthy and configuration is committed, it keeps the active executable plus one checksum-verified rollback executable. Active transaction and login-task references are never pruned, and cleanup failure does not stop the running service.

## Repository layout

```text
packages/
  protocol/          shared schemas, stable errors, RPC and tool catalog
  mcp-server/        shared HTTP daemon, discovery, sessions and installer
  vscode-extension/  VS Code runtime, handlers, managers and native UI
scripts/             Bun build, test, package and release verification
docs/agent-handbook/ progressive development guidance for coding agents
docs/adr/            architecture and security decisions
docs/acceptance/     clean-machine Windows acceptance procedures
docs/audits/         immutable dated validation evidence
```

## Development and validation

Use Bun 1.3.11. Node.js 22 or newer is needed only by Microsoft's official `vsce` packaging path. Start non-trivial work with the [Agent development handbook](docs/agent-handbook/README.md) and the impact plan:

```powershell
bun run test:plan
bun run check:affected
bun run test:e2e:affected
```

Before a pull request, or whenever the plan reports `full`, run `bun run check`. E2E infrastructure changes require `bun run test:e2e:repeat`; packaging and installation changes require `bun run test:artifact`. The [testing strategy](docs/testing-strategy.md) defines the authoritative gates.

## 中文说明

0.14.0 将实验和 Managed Worktree 从产品主流程中移除。Agent 选定 VS Code 窗口和本地工作区根目录后，可以直接读取未保存缓冲区、语言服务、Problems、现有终端、Task、Debug 与扩展状态，也可以在信任、路径、版本、哈希和指纹条件满足时执行受限修改。插件不再要求 `sessionId` 或检查点，不会为 Agent 自动打开文件或抢占焦点。

插件侧栏只保留 **Status** 与 **Agent Activity**。旧实验数据不会被加载，也不会自动迁移或删除；用户可从 Status 打开目录，或在二次确认后仅删除 Bridge 自己的元数据和快照。Git 分支和 worktree 不受该命令影响。

Codex 通过当前用户唯一的常驻 HTTP 服务访问工具。服务可在没有 VS Code 窗口时保持就绪，窗口启动后由扩展发布实例描述。安装和故障恢复见[安装手册](docs/installation.md)。
