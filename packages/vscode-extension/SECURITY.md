# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.9.0` retains the guarded v0.8 surface and adds read-only extension/IDE-signal awareness. It never activates inspected extensions, reads exports, executes contributed commands, switches Output Channels, reads private logs/Profile data or persists diagnostic bodies. Debug Console text is bounded, sanitized, since-activation only and excludes telemetry, expressions, variables and raw DAP messages. The Bridge still exposes no generic command, arbitrary Task/DAP request, terminal input, shell execution, unrestricted filesystem or Agent-callable Git operation. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for exact privacy and recovery limits.
