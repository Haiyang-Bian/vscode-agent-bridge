# Security

Please use GitHub private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. Do not publish live tokens, descriptors, IPC endpoints or an unredacted Codex configuration.

Version `0.12.0` permits arbitrary Shell/Process commands only as fingerprinted, experiment-scoped VS Code Tasks and arbitrary adapter configuration only through the bounded prepared Debug workflow. Execution is visible through Task/Debug UI, terminal/output capture, Activity and checkpoints. There is no bypass through terminal input, generic `executeCommand`, arbitrary DAP, unrestricted filesystem or Agent-callable Git. External process, network, service, database and environment effects remain explicitly unrecoverable.

Windows descriptor ACLs grant only the current SID and SYSTEM and fail closed. Canonical path checks reject symlink/junction/reparse escapes. External language-service reads require exact, expiring provider grants. Environment values, source, terminal output, Debug expressions/values and credentials never enter Activity, Doctor, logs or usage insights. See the repository [security policy](https://github.com/Haiyang-Bian/vscode-agent-bridge/blob/master/SECURITY.md) for exact limits and reporting guidance.
