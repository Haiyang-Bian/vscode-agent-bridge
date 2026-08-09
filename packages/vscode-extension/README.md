# VS Code Agent Bridge

Connect Codex to the IDE-native, read-only state of your local VS Code windows.

`0.2.0` is a Windows x64 desktop release. The extension contains a standalone MCP server, so Marketplace users do not need Bun, Node.js or the source repository.

## Setup

1. Install `AliceLin.vscode-agent-bridge` from the VS Code Marketplace.
2. Run **VS Code Agent Bridge: Configure Codex** from the Command Palette.
3. Review and confirm the exact operation. The extension installs its versioned MCP executable and updates only its marked block in `~/.codex/config.toml`.
4. Restart Codex, then ask it to call `vscode_list_instances`.

The configuration command creates a timestamped backup when the config already exists. It refuses malformed TOML and refuses to overwrite an unmanaged `[mcp_servers.vscode_agent_bridge]` table. **Remove Codex Configuration** removes only this extension's marked block. **Run Doctor** checks versions, the bridge, both executable copies and configuration state without printing tokens, IPC endpoints or private paths.

## Tools

- `vscode_list_instances`
- `vscode_get_editor_context`
- `vscode_read_document`
- `vscode_get_diagnostics`
- `vscode_get_document_symbols`
- `vscode_get_definitions`
- `vscode_get_references`
- `vscode_get_hover`

All eight tools are annotated read-only, idempotent, non-destructive and closed-world. Large results report `truncated`, `returnedCount` and, where available, `totalCount`.

## Security and support boundary

- Local Windows x64 VS Code desktop only.
- No Remote SSH, WSL, Dev Containers or Codespaces in this release.
- Read-only operation is allowed in untrusted workspaces.
- No terminal, generic `executeCommand`, file write, document edit, rename or code-action application tool.
- Per-window random authentication over local IPC; credentials and endpoints are never returned by MCP.

Source, issues, checksums and release artifacts are available at [GitHub](https://github.com/Haiyang-Bian/vscode-agent-bridge). See [SECURITY.md](SECURITY.md) before reporting a vulnerability.

---

# 中文说明

VS Code Agent Bridge 将 Codex 连接到本机 VS Code 的 IDE 原生只读状态。`0.2.0` 首发仅支持 Windows x64 桌面版，扩展已内置独立 MCP 程序，Marketplace 用户不需要安装 Bun、Node.js 或克隆源码。

安装后从命令面板运行 **VS Code Agent Bridge: Configure Codex**，确认后扩展会安装带版本的 MCP 程序，并且只管理 `~/.codex/config.toml` 中带 begin/end 标记的配置块。随后重启 Codex，先调用 `vscode_list_instances` 即可。

可读取未保存缓冲区、编辑器上下文、诊断、文档符号、定义、引用和 hover。首发不提供编辑、终端、通用 VS Code Command，也不支持 Remote SSH、WSL、Dev Container、Codespaces、Linux、macOS 或 Windows ARM64。

出现问题时运行 **VS Code Agent Bridge: Run Doctor**。它只输出状态，不输出令牌、IPC 地址或隐私路径。移除集成时使用 **Remove Codex Configuration**；该命令只删除本扩展管理的配置块，并保留其他 Codex 配置和旧版本程序。
