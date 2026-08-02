# VS Code Agent Bridge

VS Code Agent Bridge 是一个面向本地编码代理的 IDE 能力桥。项目通过 MCP Server 向 Codex 暴露稳定、可审计的工具，再由 VS Code Extension 调用编辑器和语言服务 API。

当前阶段提供一个只读纵向切片：

- 发现已连接的 VS Code 实例；
- 获取活动编辑器、选区、可见范围、脏状态和工作区信息；
- 通过随机实例标识、随机令牌和本地 IPC 完成握手；
- 明确拒绝未认证请求和不兼容的协议版本。

## Workspace

项目使用 Bun workspaces，共享一份 `bun.lock`：

```text
packages/
  protocol/          内部 RPC Schema、错误码和注册表约定
  mcp-server/        Codex 启动的 STDIO MCP Server
  vscode-extension/  运行在 VS Code Extension Host 中的能力提供方
```

`protocol` 是共享代码，不是第三个运行时服务。

## 开发

需要 Bun 1.3 或更高版本。

```powershell
bun install
bun run check
```

单独运行 MCP Server：

```powershell
bun run --cwd packages/mcp-server start
```

构建产物位于各 workspace 的 `dist/`。

## 连接 Codex

1. 构建并将 `packages/vscode-extension` 安装或以 Extension Development Host 运行。
2. 将 `examples/codex.config.toml` 中的路径替换为本仓库绝对路径。
3. 将配置复制到项目级 `.codex/config.toml` 或合并到用户级 `~/.codex/config.toml`。
4. 重启 Codex 客户端或扩展，使 MCP Server 配置生效。

项目不会默认写入活动的 `.codex/config.toml`，以免尚未安装 VS Code Extension 时让 Codex 启动一个不可用的工具服务器。

## 设计约束

- 普通文件读写和 Shell 命令继续由编码代理自身完成。
- MCP 工具只覆盖未保存缓冲区、诊断、语言服务、导航和受保护的编辑操作。
- 不提供任意 VS Code Command 或终端执行入口。
- 写操作将在后续阶段通过文档版本或内容哈希处理并发冲突。

架构决策见 [`docs/adr`](docs/adr)。
