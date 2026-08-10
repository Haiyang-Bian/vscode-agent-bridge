# VS Code Agent Bridge

Connect Codex to guarded IDE workflow autonomy, recoverable Agent experiments, VS Code Tasks, bounded debugging and read-only terminal observation in local VS Code windows.

`0.7.0` is an unpublished Windows x64 desktop candidate distributed by side-loaded VSIX and upgrades directly over `0.6.1`. The package contains a standalone MCP server, so testers do not need Bun, Node.js or the source repository.

## Setup

1. Use **Extensions > ... > Install from VSIX...** and select the checksum-verified candidate package.
2. Run **VS Code Agent Bridge: Configure Bridge**. The defaults are enabled with `explicit` execution.
3. Run **VS Code Agent Bridge: Configure Codex** and confirm. The extension installs its versioned MCP executable and updates only its marked block in `~/.codex/config.toml`.
4. Restart Codex, then ask it to call `vscode_list_instances`.

Configuration creates a timestamped backup when the file exists, refuses malformed TOML, and refuses to overwrite an unmanaged `[mcp_servers.vscode_agent_bridge]` table. **Remove Codex Configuration** removes only the marked block. **Run Doctor** checks versions, bridge state, executable copies, configuration and experiment storage health without printing tokens, IPC endpoints, source or private paths.

## Bridge and experiment workflow

The bridge exposes 42 bounded IDE tools. v0.7 adds guarded JSONC/resource updates, fingerprinted workspace Tasks and a fixed-whitelist Debug workflow. Starting an experiment still triggers first-use workspace onboarding. Agent acceptance, restore, Finalize, abandon, deletion and all Managed Worktree actions remain unavailable through MCP.

- The machine master switch stops RPC and removes the instance descriptor when disabled.
- `explicit` rejects delayed execution such as folder-open Tasks.
- `aggressive` permits bounded deferred configuration and reports that effect in results, Activity and Doctor.
- Codex or a supervising Agent owns approval decisions from the MCP annotations; Configure Codex does not write an approval mode.
- Restrictive v0.6 policy selections require an explicit migration choice before v0.7 publishes the bridge.

Change Sets, formatter edits, pure-text Code Actions, saves, configuration edits and resource changes require an active onboarded experiment plus fresh document/resource preconditions. Text files and bounded directories may be created, renamed or deleted inside the root; `.git`, traversal, symbolic resources, binaries and unrestricted paths are rejected. A formatter that reports no edits remains a successful no-op.

Tasks are first enumerated from VS Code, then executed only by stable ID and fingerprint; MCP cannot supply an arbitrary command or Task object. Debug starts only a named static launch configuration or compound. Threads, stacks, scopes and variables are bounded and paged, control uses a fixed action enum, source breakpoints stay inside the experiment root, and arbitrary DAP requests are unavailable. Task and Debug side effects outside captured workspace text/resources cannot be rolled back.

The native **Agent Activity** view shows bounded operation state without source, Task commands, terminal output or Debug values. By default every validated text target is opened as a fixed tab before mutation and the first target receives focus. Use **Configure Workspace Experiment** to enable/disable Agent writes for one root and select `focusFirst`, `focusEach`, `firstOnly` or `off`. Configuration files can be read and changed only through the bounded JSONC tools.

For deterministic acceptance testing, the machine setting `vscodeAgentBridge.enableAcceptanceFixtures` may be enabled temporarily. It registers one pure-text Quick Fix for existing `*.bridgeaction` documents containing `BROKEN_E2E`; the action replaces that marker with `FIXED_E2E`. The setting is off by default and should be disabled after the test.

Run **Start Agent Experiment** on an ordinary Git experiment branch. The Agent may use bounded IDE workflows while automatic checkpoints remain separate from Git. Finalize may use the current saved state if no candidate was accepted; an existing accepted candidate stays authoritative. The user then uses normal Git squash/rebase to create the desired formal history. Review, restore and explicit acceptance remain available in the native **Agent Experiments** view.

Managed Worktree is an advanced mode for stronger isolation. Start **Start Managed Worktree Experiment (Advanced)** from a completely clean named branch. You may create many private checkpoint commits, but only a user-accepted reachable commit can be promoted. It still never pushes or cleans up automatically.

Terminal observation covers only commands seen after extension activation with Shell Integration. Output is ANSI/control-sequence sanitized, memory-only, limited to 1 MiB per execution and 16 MiB per window, and reports missing prefixes or dropped characters. The Agent cannot create a terminal, send input or execute an arbitrary command; only a previously enumerated VS Code Task can start through the Task API.

## Security and support boundary

- Local Windows x64 VS Code desktop only.
- No Remote SSH, WSL, Dev Containers or Codespaces.
- Untrusted, remote, WSL and container workspaces do not publish the bridge; local configuration/Doctor UI remains available.
- No terminal input, generic `executeCommand`, arbitrary Task/DAP request, unrestricted filesystem or Agent-callable Git tool.
- Rename is restricted to the fixed VS Code provider and rejected if it returns file operations.
- Git is not exposed through MCP. User-only managed commands use fixed `execFile` operations and never fetch, pull, push, change remotes/config, prune worktrees or auto-delete branches.
- Per-window random authentication over local IPC; credentials and endpoints are never returned by MCP.

Source, issues, checksums and release artifacts are available at [GitHub](https://github.com/Haiyang-Bian/vscode-agent-bridge). See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

# 中文说明

VS Code Agent Bridge 将 Codex 连接到本机 VS Code 的 IDE 原生状态，提供受实验保护的配置/资源修改、VS Code Tasks、受限调试和终端只读观测。`0.7.0` 是暂未发布 Marketplace 的 Windows x64 候选版本，可直接覆盖升级 `0.6.1`；旁加载测试不需要 Bun、Node.js 或源码。

安装后先运行 **Configure Bridge**。机器总开关默认启用；`explicit`（默认）只允许运行 MCP 当前明确请求的工作流，`aggressive` 才允许 folder-open Task 等延迟效果。工具审批由 Codex、用户配置或监督 Agent 根据 MCP 注解决定，**Configure Codex** 不再写审批档位。旧版显式限制策略不会被静默扩权，升级后必须由用户选择。

首次运行实验命令或由 Agent 请求启动实验时，扩展只盘点 `.vscode`、settings、launch、tasks 与 workspace 文件，并在用户确认后通过 VS Code Configuration API 写入本工作区根的 Bridge 设置。取消时不改文件；launch、tasks 和 workspace 文件在 v0.6 中只盘点、不修改。此后 Agent 可以按任务命名普通实验、列出实验、重命名普通实验并创建检查点，但接受、恢复、结束、放弃、删除和全部 Managed 操作仍由用户控制。

全部写操作仍要求明确实例/会话、根目录及版本、哈希、fingerprint 或 revision 前置条件。Agent 可以用 JSON Pointer 保留注释地维护 settings/launch/tasks/workspace JSONC，并在根目录内准备文本文件/目录的创建、重命名和删除；`.git`、越界、符号链接、二进制和工作区 folders 修改会被拒绝。写入与 Task/Debug 生命周期会显示在 **Agent Activity**，但不记录源码、命令、输出、表达式或值。

Agent 只能运行 VS Code 已枚举且 fingerprint 未变化的 Task，不能传入 Shell 或任意 Task 对象。调试只能按名称启动静态配置，DAP 仅开放 threads、stackTrace、scopes、variables、固定控制、evaluate 和 setVariable 等白名单能力。任务或调试对外部服务、数据库、网络、环境和 Git 历史造成的副作用不在快照恢复范围内。

为了稳定覆盖 Code Action 正向验收，可临时开启机器级设置 `vscodeAgentBridge.enableAcceptanceFixtures`。它只为包含 `BROKEN_E2E` 的既有 `*.bridgeaction` 文档提供一个纯文本 Quick Fix，并将其替换为 `FIXED_E2E`；该设置默认关闭，验收后应重新关闭。

默认 Git 流程是“普通实验分支 + 自动检查点 + 用户执行 Git squash”。自动检查点不会生成提交。自治档位下如果没有接受候选，Finalize 可使用当前已保存状态；如果已有接受候选，它仍然优先。恢复、永久删除和 Managed Git 晋升继续要求用户确认。

终端能力仍严格只读：可以读取终端状态、扩展激活后捕获的 Shell Integration 执行和净化后的分页输出，但不能创建终端或发送输入。Task 启动只通过已枚举的 VS Code Tasks API；不存在任意终端命令工具。

若确实需要更强的文件与提交隔离，可使用标记为 Advanced 的 Managed Worktree；它保留 v0.4 的私有提交、显式同步和单提交晋升语义，不是默认工作流。

出现问题时运行 **VS Code Agent Bridge: Run Doctor**。移除集成时使用 **Remove Codex Configuration**；该命令只删除本扩展管理的配置块，并保留其他 Codex 配置和旧版本程序。
