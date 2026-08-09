# Security Policy

## Supported versions

Security fixes are provided for the latest side-loaded candidate while Marketplace publication remains disabled. During this cycle, `0.4.x` is the supported line.

## Reporting a vulnerability

Do not open a public issue for a suspected credential, local IPC, configuration overwrite or arbitrary-command vulnerability. Use GitHub's private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. If private reporting is unavailable, open a minimal issue requesting a private contact channel without including exploit details or secrets.

Include the extension version, Windows and VS Code versions, reproduction steps, impact, and whether any descriptor, token or Codex configuration was exposed. Never attach live tokens or an unredacted `~/.codex/config.toml`.

## Security boundary

Version `0.3.0` is local-only. It does not expose terminal execution, generic VS Code commands, filesystem APIs, Git commands or file resource operations. Text mutation requires a trusted workspace, a user-started experiment, explicit instance and session IDs, Codex write approval, and fresh version plus content-hash preconditions. Authentication material, IPC endpoints, experiment content and absolute paths are excluded from public results, errors and Doctor output.

Experiment snapshots can contain source code and remain only in VS Code `globalStorageUri`; they are not synchronized or uploaded by this extension. Restore and Finalize refuse incomplete resource-level coverage. Remote extension hosts are rejected.

Version `0.4.0` adds no Agent-callable Git tools. User-only managed-worktree commands use `execFile` with fixed subcommands, validated full object IDs, branch names, repository roots and managed paths. They never fetch, pull, push, mutate remotes/config, prune worktrees or automatically delete worktrees. Promotion stops on target drift and never uses `reset --hard`; failed cherry-pick recovery is limited to `cherry-pick --abort` and otherwise enters a recovery-required state.
