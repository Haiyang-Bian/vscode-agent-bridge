# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.5.1` provides guarded IDE save/format/pure-text Code Actions and read-only terminal observation. It exposes no terminal input, shell execution or Agent-callable Git operation. Terminal output is sanitized, bounded, memory-only and reports incomplete coverage. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for policy enforcement, snapshot privacy, promotion recovery, the supported version and reporting details.
