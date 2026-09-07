# VS Code Agent Bridge

Connect Codex to guarded IDE workflow autonomy, recoverable Agent experiments, VS Code Tasks, bounded debugging and read-only terminal observation in local VS Code windows.

`0.13.0` is an unpublished Windows x64 desktop candidate using Bridge protocol v11 and exactly 64 tools. It is distributed by side-loaded VSIX and migrates managed Codex configurations to a per-user shared HTTP daemon. The package contains a standalone MCP server, so testers do not need Bun, Node.js or the source repository.

## Setup

1. Use **Extensions > ... > Install from VSIX...** and select the checksum-verified candidate package.
2. Run **VS Code Agent Bridge: Configure Bridge**. The defaults are enabled with `explicit` execution.
3. Run **VS Code Agent Bridge: Configure Codex** and confirm. The extension installs its versioned HTTP daemon and current-user login task, verifies it, then updates only its marked block in `~/.codex/config.toml`.
4. Start a new Codex client, then ask it to call `vscode_list_instances`.

Configuration creates a timestamped backup when the file exists, refuses malformed TOML, and refuses to overwrite an unmanaged `[mcp_servers.vscode_agent_bridge]` table. **Remove Codex Configuration** stops the shared daemon, removes its login task and marked block, and preserves version files. **Run Doctor** checks versions, authenticated HTTP health, singleton PID, login task, configuration and experiment storage health without printing tokens, IPC endpoints, source or private paths.

## Bridge and experiment workflow

The bridge exposes 64 catalog-derived IDE tools. v0.12 adds temporary and persistable Agent Task/Debug definitions while retaining the v0.11 reviewed adapter and v0.10 Marketplace/Profile boundaries. Prepared definitions expire after 30 minutes, bind the current instance/session/root and require complete fingerprints. Starting an experiment still triggers first-use workspace onboarding. Agent acceptance, restore, Finalize, abandon, deletion and all Managed Worktree actions remain unavailable through MCP.

Marketplace results distinguish a versioned Bridge-maintained `official` directory from the Marketplace's separate Verified Publisher signal. Install plans expire, are one-use, lock exact stable versions and resolve at most 20 dependency or extension-pack members. Apply uses only VS Code's native install command and preserves Publisher Trust/reload UI; there is no CLI, URL, VSIX, downgrade, uninstall or automatic-update fallback. Configuration reads and writes are limited to non-sensitive keys declared by an installed extension. Global current-Profile changes are locally undoable for 30 days/100 records; Workspace/Folder changes are captured by the active experiment. Use **Undo Last Agent Profile Change** for the latest unchanged Global value and **Create Capability Profile** to open VS Code's native Profiles manager.

The Activity Bar container is named **VS Code Agent Bridge** and presents Overview, Experiments, Agent Activity, Capabilities and Usage Insights as native views. Local insight events contain only tool/category, outcome, timing and size buckets, truncation and stable error codes. They never contain parameters, results, paths, source, hashes, terminal output, debug expressions/values, environment variables or credentials; they remain local for 30 days with a 20 MiB cap and can be cleared or exported as aggregates.

Installed extensions and manifest contributions can be inspected without activating the extension, reading exports or executing contributed commands. Profile name/ID are reported as unavailable because stable VS Code APIs do not expose them. Problems events are summary-only and memory-bound. Output reads require an already opened Output document; the Bridge never forces channel selection or reads private logs. Debug Console capture starts with Bridge activation, discards telemetry and variable/evaluate data, sanitizes controls and reports bounded-loss coverage.

The reviewed `python.environment` adapter uses Microsoft's pinned `@vscode/python-extension` facade for `ms-python.python`. It reports only the active interpreter path, environment type/name, Python version and bitness. It does not expose environment variables, packages, credentials, raw Python logs, arbitrary exports or extension actions. Missing and incompatible extensions fail closed; install Python support through the v0.10 Marketplace workflow first when needed.

- The machine master switch stops RPC and removes the instance descriptor when disabled.
- `explicit` is the only execution mode and rejects folder-open Tasks, dependencies and other delayed execution.
- A legacy `aggressive` value is treated as `explicit`; Doctor offers to open the stale setting or user configuration but never deletes it.
- Codex or a supervising Agent owns approval decisions from the MCP annotations; Configure Codex does not write an approval mode.
- Restrictive v0.6 policy selections require an explicit migration choice before v0.7 publishes the bridge.

Change Sets, formatter edits, pure-text Code Actions, saves, configuration edits and resource changes require an active onboarded experiment plus fresh document/resource preconditions. Text files and bounded directories may be created, renamed or deleted inside the root; `.git`, traversal, symbolic resources, binaries and unrestricted paths are rejected. A formatter that reports no edits remains a successful no-op.

The Agent may prepare Shell command-line, structured Shell or Process Tasks and execute them only through `vscode.tasks.executeTask()`. Activity shows the full command, arguments and cwd; environment values are excluded. A separate exact-hash/provenance call is required to persist to `tasks.json`. Debug likewise accepts a bounded JSON-compatible adapter configuration, starts it through the VS Code Debug API by configuration ID plus fingerprint and persists only through a separate guarded call. Threads, stacks, scopes and variables remain bounded and paged, controls use a fixed enum, and arbitrary DAP requests are unavailable. External Task/Debug effects cannot be rolled back.

The native **Agent Activity** view shows bounded operation state and correlates prepare/start, execution ID, terminal or Debug session, exit, checkpoint and fingerprint. It intentionally includes Task command/arguments/cwd and Debug execution fields, but never environment values, source text, terminal output or Debug values. By default every validated text target is opened as a fixed tab before mutation and the first target receives focus.

For deterministic acceptance testing, the machine setting `vscodeAgentBridge.enableAcceptanceFixtures` may be enabled temporarily. It registers one pure-text Quick Fix for existing `*.bridgeaction` documents containing `BROKEN_E2E`; the action replaces that marker with `FIXED_E2E`. The setting is off by default and should be disabled after the test.

Run **Start Agent Experiment** on an ordinary Git experiment branch. The Agent may use bounded IDE workflows while automatic checkpoints remain separate from Git. Finalize may use the current saved state if no candidate was accepted; an existing accepted candidate stays authoritative. The user then uses normal Git squash/rebase to create the desired formal history. Review, restore and explicit acceptance remain available in the native **Experiments** view.

Managed Worktree is an advanced mode for stronger isolation. Start **Start Managed Worktree Experiment (Advanced)** from a completely clean named branch. You may create many private checkpoint commits, but only a user-accepted reachable commit can be promoted. It still never pushes or cleans up automatically.

Terminal observation covers only commands seen after extension activation with Shell Integration. Output is ANSI/control-sequence sanitized, memory-only, limited to 1 MiB per execution and 16 MiB per window, and reports missing prefixes or dropped characters. The Agent cannot create a terminal or send input. Arbitrary commands must be represented as observable, fingerprinted VS Code Tasks rather than bypassing the IDE.

## Security and support boundary

- Local Windows x64 VS Code desktop only.
- No Remote SSH, WSL, Dev Containers or Codespaces.
- Untrusted, remote, WSL and container workspaces do not publish the bridge; local configuration/Doctor UI remains available.
- No terminal input, generic `executeCommand`, arbitrary DAP request, IDE-bypassing Shell/filesystem execution or Agent-callable Git tool.
- Rename is restricted to the fixed VS Code provider and rejected if it returns file operations.
- Git is not exposed through MCP. User-only managed commands use fixed `execFile` operations and never fetch, pull, push, change remotes/config, prune worktrees or auto-delete branches.
- Per-window random authentication over local IPC; credentials and endpoints are never returned by MCP.

Source, issues, checksums and release artifacts are available at [GitHub](https://github.com/Haiyang-Bian/vscode-agent-bridge). See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

# 中文说明

VS Code Agent Bridge 将 Codex 连接到本机 VS Code 的 IDE 原生状态，提供受实验保护的配置/资源修改、VS Code Tasks、受限调试和终端只读观测。`0.13.0` 使用 Bridge protocol v11 和 64 个工具，是暂未发布 Marketplace 的 Windows x64 候选版本，将受管 Codex 配置迁移至当前用户共享的常驻 HTTP 服务；旁加载测试不需要 Bun、Node.js 或源码。

侧栏以插件全名 **VS Code Agent Bridge** 展示 Overview、Experiments、Agent Activity、Capabilities 和 Usage Insights。64 个工具的名称、分类、注解、恢复边界和敏感级别来自同一权威目录。v0.12 增加实验内临时 Task/Debug 定义及独立持久化；v0.11 的静态审核扩展适配器和官方 Python 活动环境边界保持不变。

安装后先运行 **Configure Bridge**。机器总开关默认启用；`explicit` 是唯一模式，只允许运行 MCP 当前明确请求的工作流。旧 `aggressive` 值会安全降级，Doctor 只提示清理，不删除用户已有的 folder-open 配置。工具审批由 Codex、用户配置或监督 Agent 根据 MCP 注解决定。

首次运行实验命令或由 Agent 请求启动实验时，扩展只盘点 `.vscode`、settings、launch、tasks 与 workspace 文件，并在用户确认后通过 VS Code Configuration API 写入本工作区根的 Bridge 设置。取消时不改文件；launch、tasks 和 workspace 文件在 v0.6 中只盘点、不修改。此后 Agent 可以按任务命名普通实验、列出实验、重命名普通实验并创建检查点，但接受、恢复、结束、放弃、删除和全部 Managed 操作仍由用户控制。

全部写操作仍要求明确实例/会话、根目录及版本、哈希、fingerprint 或 revision 前置条件。Agent 可以用 JSON Pointer 保留注释地维护 settings/launch/tasks/workspace JSONC，并在根目录内准备文本文件/目录的创建、重命名和删除；`.git`、越界、符号链接、二进制和工作区 folders 修改会被拒绝。写入与 Task/Debug 生命周期会显示在 **Agent Activity**，但不记录源码、命令、输出、表达式或值。

Agent 可以提交 Shell command line、结构化 Shell 或 Process Task，但只能经过 VS Code Task API，在 Task/终端/Activity 中可观察，并受实验、根目录和完整 fingerprint 约束。Debug 可提交严格 JSON-compatible adapter 配置，并按 configurationId+fingerprint 启动。Task/Debug 默认临时，写入 `tasks.json`/`launch.json` 必须另行调用带精确哈希和 provenance 的持久化工具。环境变量只显示名称，不记录值；外部服务、数据库、网络、环境和 Git 历史副作用不在快照恢复范围内。

为了稳定覆盖 Code Action 正向验收，可临时开启机器级设置 `vscodeAgentBridge.enableAcceptanceFixtures`。它只为包含 `BROKEN_E2E` 的既有 `*.bridgeaction` 文档提供一个纯文本 Quick Fix，并将其替换为 `FIXED_E2E`；该设置默认关闭，验收后应重新关闭。

默认 Git 流程是“普通实验分支 + 自动检查点 + 用户执行 Git squash”。自动检查点不会生成提交。自治档位下如果没有接受候选，Finalize 可使用当前已保存状态；如果已有接受候选，它仍然优先。恢复、永久删除和 Managed Git 晋升继续要求用户确认。

终端能力仍严格只读：可以读取终端状态、扩展激活后捕获的 Shell Integration 执行和净化后的分页输出，但不能创建终端或发送输入。任意命令必须先成为带 fingerprint 的 VS Code Task，不存在绕过 IDE 的终端命令工具。

若确实需要更强的文件与提交隔离，可使用标记为 Advanced 的 Managed Worktree；它保留 v0.4 的私有提交、显式同步和单提交晋升语义，不是默认工作流。

出现问题时运行 **VS Code Agent Bridge: Run Doctor**。移除集成时使用 **Remove Codex Configuration**；该命令只删除本扩展管理的配置块，并保留其他 Codex 配置和旧版本程序。
