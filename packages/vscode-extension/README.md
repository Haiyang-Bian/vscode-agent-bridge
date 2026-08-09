# VS Code Agent Bridge

Connect Codex to IDE-native state and recoverable Agent experiments in local VS Code windows.

`0.4.0` is an unpublished Windows x64 desktop candidate distributed by side-loaded VSIX. The package contains a standalone MCP server, so testers do not need Bun, Node.js or the source repository.

## Setup

1. Use **Extensions > ... > Install from VSIX...** and select the checksum-verified candidate package.
2. Run **VS Code Agent Bridge: Configure Codex** from the Command Palette.
3. Review and confirm the operation. The extension installs its versioned MCP executable and updates only its marked block in `~/.codex/config.toml`.
4. Restart Codex, then ask it to call `vscode_list_instances`.

Configuration creates a timestamped backup when the file exists, refuses malformed TOML, and refuses to overwrite an unmanaged `[mcp_servers.vscode_agent_bridge]` table. **Remove Codex Configuration** removes only the marked block. **Run Doctor** checks versions, bridge state, executable copies, configuration and experiment storage health without printing tokens, IPC endpoints, source or private paths.

## Tools and experiment workflow

The extension exposes eight bounded language-service tools plus:

- `vscode_get_experiment`
- `vscode_list_experiment_checkpoints`
- `vscode_prepare_text_edits`
- `vscode_prepare_rename`
- `vscode_apply_change_set`
- `vscode_record_experiment_evidence`

Change Sets can only edit existing text documents inside a user-started experiment. Every write requires explicit instance/session routing, Codex write approval, fresh document version and SHA-256 preconditions. The extension never auto-saves.

Run **Start Agent Experiment**, make several Agent or manual attempts, review the native **Agent Experiments** tree and diffs, then mark one checkpoint accepted. **Restore Accepted Candidate** creates a safety checkpoint and leaves restored buffers dirty. **Finalize Agent Experiment** only closes the experiment after saved content matches the accepted candidate; it does not stage or commit. Snapshots stay in local VS Code extension storage and are retained for up to 30 days or 500 MB by default.

For Git isolation, start **Start Managed Worktree Experiment** from a completely clean named branch. The extension creates a locked private worktree and opens it in a new window. You may create many private checkpoint commits, but only a user-accepted reachable commit can be promoted. If the target moves, use the separate **Sync Managed Experiment** flow. **Finalize Managed Experiment** runs from the clean original target window and adds exactly one verified commit; it never pushes or cleans up automatically.

## Security and support boundary

- Local Windows x64 VS Code desktop only.
- No Remote SSH, WSL, Dev Containers or Codespaces.
- Read-only operation is allowed in untrusted workspaces; experiments and Change Sets require trust.
- No terminal, generic `executeCommand`, filesystem, Git or resource-operation tool.
- Rename is restricted to the fixed VS Code provider and rejected if it returns file operations.
- Git is not exposed through MCP. User-only managed commands use fixed `execFile` operations and never fetch, pull, push, change remotes/config, prune worktrees or auto-delete branches.
- Per-window random authentication over local IPC; credentials and endpoints are never returned by MCP.

Source, issues, checksums and release artifacts are available at [GitHub](https://github.com/Haiyang-Bian/vscode-agent-bridge). See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

# 中文说明

VS Code Agent Bridge 将 Codex 连接到本机 VS Code 的 IDE 原生状态，并提供可恢复的 Agent 实验会话。`0.4.0` 是暂未发布 Marketplace 的 Windows x64 候选版本；通过 VSIX 旁加载测试时不需要安装 Bun、Node.js 或克隆源码。

安装后从命令面板运行 **VS Code Agent Bridge: Configure Codex**，确认后扩展会安装带版本的 MCP 程序，并且只管理 `~/.codex/config.toml` 中带 begin/end 标记的配置块。随后重启 Codex，先调用 `vscode_list_instances`。

在可信的本地工作区中，用户可运行 **Start Agent Experiment** 创建会话。Agent 只能先准备短期、一次性的纯文本 Change Set，再用明确的实例 ID、会话 ID、文档版本和 SHA-256 校验原子应用；应用后文件保持未保存状态。

Activity Bar 中的 **Agent Experiments** 视图用于查看检查点、证据和 diff，用户可以选择接受候选、恢复候选或 Finalize。保存不等于接受，检查点不等于 Git 提交；恢复不会自动保存，Finalize 也不会暂存或提交。实验文本只保存在 VS Code 本地扩展存储中，默认保留 30 天或总计 500 MB。

本版本不提供终端、通用 VS Code Command、通用文件系统或 Git 工具；不允许创建、删除、重命名文件，也不支持 Remote SSH、WSL、Dev Container、Codespaces、Linux、macOS 或 Windows ARM64。

若需要隔离保存和私有试错提交，可从完全干净的具名 Git 分支运行 **Start Managed Worktree Experiment**。扩展会创建并锁定一个私有 worktree，在新窗口中继续使用实验检查点。用户可以创建多个私有提交，但只能选择可达的 Git 检查点作为接受候选。目标分支漂移时必须显式同步；最终从原目标窗口执行 **Finalize Managed Experiment**，只增加一个经过 parent/tree 校验的正式提交，不自动 push，也不自动清理 worktree 或私有分支。

出现问题时运行 **VS Code Agent Bridge: Run Doctor**。移除集成时使用 **Remove Codex Configuration**；该命令只删除本扩展管理的配置块，并保留其他 Codex 配置和旧版本程序。
