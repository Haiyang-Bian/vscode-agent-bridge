# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.7.0` adds guarded JSONC/resource workflows, fingerprinted VS Code Tasks and a fixed-whitelist Debug Adapter workflow under a trusted local experiment. It retains read-only terminal observation and exposes no generic command, arbitrary Task/DAP request, terminal input, shell execution, unrestricted filesystem or Agent-callable Git operation. Task and Debug can have external side effects that snapshots cannot reverse; annotations and the repository policy state this boundary explicitly. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for exact privacy and recovery limits.
