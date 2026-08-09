# Security Policy

## Supported versions

Security fixes are provided for the latest Marketplace release. During the initial release cycle, `0.2.x` is the supported line.

## Reporting a vulnerability

Do not open a public issue for a suspected credential, local IPC, configuration overwrite or arbitrary-command vulnerability. Use GitHub's private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. If private reporting is unavailable, open a minimal issue requesting a private contact channel without including exploit details or secrets.

Include the extension version, Windows and VS Code versions, reproduction steps, impact, and whether any descriptor, token or Codex configuration was exposed. Never attach live tokens or an unredacted `~/.codex/config.toml`.

## Security boundary

Version `0.2.0` is local-only and read-only. It does not expose terminal execution, generic VS Code commands, filesystem mutation or editor mutation. Remote extension hosts are rejected. Authentication tokens and IPC endpoints remain in local descriptor files and are excluded from public MCP results and Doctor output.
