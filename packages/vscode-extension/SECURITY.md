# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.8.0` retains the guarded v0.7 IDE workflow surface and adds a classified capability catalog plus local aggregate usage insights. Insight files never contain parameters, results, paths, source, hashes, terminal data, debug expressions/values, environment variables or credentials; they are local-only, bounded to 30 days/20 MiB and explicitly clearable. The Bridge still exposes no generic command, arbitrary Task/DAP request, terminal input, shell execution, unrestricted filesystem or Agent-callable Git operation. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for exact privacy and recovery limits.
