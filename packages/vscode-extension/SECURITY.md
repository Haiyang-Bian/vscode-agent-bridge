# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.4.0` adds user-only managed worktree commands but exposes no Git operation through MCP. Git execution is fixed, local and path-validated; it never contacts remotes or automatically cleans up. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for snapshot privacy, promotion recovery, the supported version and reporting details.
