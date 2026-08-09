# VS Code Agent Bridge

Connect Codex to capability-limited IDE autonomy, recoverable Agent experiments and read-only terminal observation in local VS Code windows.

`0.5.1` is an unpublished Windows x64 desktop candidate distributed by side-loaded VSIX. The package contains a standalone MCP server, so testers do not need Bun, Node.js or the source repository.

## Setup

1. Use **Extensions > ... > Install from VSIX...** and select the checksum-verified candidate package.
2. Run **VS Code Agent Bridge: Configure Agent Policies**. The defaults are `autonomous + allow`.
3. Run **VS Code Agent Bridge: Configure Codex** and confirm. The extension installs its versioned MCP executable and updates only its marked block in `~/.codex/config.toml`.
4. Restart Codex, then ask it to call `vscode_list_instances`.

Configuration creates a timestamped backup when the file exists, refuses malformed TOML, and refuses to overwrite an unmanaged `[mcp_servers.vscode_agent_bridge]` table. **Remove Codex Configuration** removes only the marked block. **Run Doctor** checks versions, bridge state, executable copies, configuration and experiment storage health without printing tokens, IPC endpoints, source or private paths.

## Policies and experiment workflow

The bridge exposes 21 bounded IDE tools. In addition to editor/language-service and experiment history tools, v0.5 adds guarded save, formatting, Code Action discovery/application, terminal metadata, observed executions and sanitized output paging.

- `autonomous` allows guarded edits and saves without per-tool approval.
- `review` prompts for writes and requires an accepted checkpoint for Finalize.
- `readOnly` removes write tools from Codex configuration and makes extension handlers reject writes.
- Terminal policy `allow` exposes Shell Integration details in trusted workspaces, `metadataOnly` redacts command/output, and `deny` rejects all terminal tools.

Change Sets, formatter edits, pure-text Code Actions and saves can only target existing documents inside a user-started experiment. Every write requires explicit instance/session routing plus fresh document version and SHA-256 preconditions. File creation/deletion/rename and command-bearing Code Actions are rejected. A formatter that reports no edits is treated as a successful no-op, not as a missing provider.

For deterministic acceptance testing, the machine setting `vscodeAgentBridge.enableAcceptanceFixtures` may be enabled temporarily. It registers one pure-text Quick Fix for existing `*.bridgeaction` documents containing `BROKEN_E2E`; the action replaces that marker with `FIXED_E2E`. The setting is off by default and should be disabled after the test.

Run **Start Agent Experiment** on an ordinary Git experiment branch. The Agent may edit, format, apply safe Quick Fixes and save while automatic checkpoints remain separate from Git. In autonomous mode, Finalize may use the current saved state if no candidate was accepted; an existing accepted candidate stays authoritative. The user then uses normal Git squash/rebase to create the desired formal history. Review, restore and explicit acceptance remain available in the native **Agent Experiments** view.

Managed Worktree is an advanced mode for stronger isolation. Start **Start Managed Worktree Experiment (Advanced)** from a completely clean named branch. You may create many private checkpoint commits, but only a user-accepted reachable commit can be promoted. It still never pushes or cleans up automatically.

Terminal observation covers only commands seen after extension activation with Shell Integration. Output is ANSI/control-sequence sanitized, memory-only, limited to 1 MiB per execution and 16 MiB per window, and reports missing prefixes or dropped characters. The Agent cannot create a terminal, send input or execute a command.

## Security and support boundary

- Local Windows x64 VS Code desktop only.
- No Remote SSH, WSL, Dev Containers or Codespaces.
- Read-only operation is allowed in untrusted workspaces; experiments and Change Sets require trust.
- No terminal input/execution, generic `executeCommand`, filesystem, Git or resource-operation tool.
- Rename is restricted to the fixed VS Code provider and rejected if it returns file operations.
- Git is not exposed through MCP. User-only managed commands use fixed `execFile` operations and never fetch, pull, push, change remotes/config, prune worktrees or auto-delete branches.
- Per-window random authentication over local IPC; credentials and endpoints are never returned by MCP.

Source, issues, checksums and release artifacts are available at [GitHub](https://github.com/Haiyang-Bian/vscode-agent-bridge). See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

# 中文说明

VS Code Agent Bridge 将 Codex 连接到本机 VS Code 的 IDE 原生状态，提供能力受限的自治、可恢复实验会话和终端只读观测。`0.5.1` 是暂未发布 Marketplace 的 Windows x64 候选版本；通过 VSIX 旁加载测试时不需要安装 Bun、Node.js 或克隆源码。

安装后先运行 **Configure Agent Policies**。默认 `autonomous + allow` 允许 Agent 在严格校验下编辑、格式化、应用纯文本 Code Action 并保存已有文档；`review` 要求写审批和显式接受；`readOnly` 在配置与扩展处理器两层拒绝写入。随后运行 **Configure Codex** 并重启 Codex。

在可信的本地工作区中运行 **Start Agent Experiment**。所有写操作仍要求明确实例/会话 ID、文档版本和 SHA-256；保存只允许已打开且已存在的 `file:` 文档，格式化只调用固定 Provider，Code Action 只能包含纯文本 WorkspaceEdit，不能包含 command 或资源操作。Formatter 返回零个 edit 时按成功 no-op 处理。

为了稳定覆盖 Code Action 正向验收，可临时开启机器级设置 `vscodeAgentBridge.enableAcceptanceFixtures`。它只为包含 `BROKEN_E2E` 的既有 `*.bridgeaction` 文档提供一个纯文本 Quick Fix，并将其替换为 `FIXED_E2E`；该设置默认关闭，验收后应重新关闭。

默认 Git 流程是“普通实验分支 + 自动检查点 + 用户执行 Git squash”。自动检查点不会生成提交。自治档位下如果没有接受候选，Finalize 可使用当前已保存状态；如果已有接受候选，它仍然优先。恢复、永久删除和 Managed Git 晋升继续要求用户确认。

终端能力严格只读：可以读取终端状态、扩展激活后捕获的 Shell Integration 执行和净化后的分页输出，但不能创建终端、发送输入或执行命令。输出只保存在内存并明确报告覆盖缺口。`metadataOnly` 只返回状态，`deny` 完全拒绝终端工具。

若确实需要更强的文件与提交隔离，可使用标记为 Advanced 的 Managed Worktree；它保留 v0.4 的私有提交、显式同步和单提交晋升语义，不是默认工作流。

出现问题时运行 **VS Code Agent Bridge: Run Doctor**。移除集成时使用 **Remove Codex Configuration**；该命令只删除本扩展管理的配置块，并保留其他 Codex 配置和旧版本程序。
