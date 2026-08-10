# Security Policy

## Supported versions

Security fixes are provided for the latest side-loaded candidate while Marketplace publication remains disabled. During this cycle, `0.8.x` is the supported line.

## Reporting a vulnerability

Do not open a public issue for a suspected credential, local IPC, configuration overwrite or arbitrary-command vulnerability. Use GitHub's private vulnerability reporting for `Haiyang-Bian/vscode-agent-bridge`. If private reporting is unavailable, open a minimal issue requesting a private contact channel without including exploit details or secrets.

Include the extension version, Windows and VS Code versions, reproduction steps, impact, and whether any descriptor, token or Codex configuration was exposed. Never attach live tokens or an unredacted `~/.codex/config.toml`.

## Security boundary

Version `0.3.0` is local-only. It does not expose terminal execution, generic VS Code commands, filesystem APIs, Git commands or file resource operations. Text mutation requires a trusted workspace, a user-started experiment, explicit instance and session IDs, Codex write approval, and fresh version plus content-hash preconditions. Authentication material, IPC endpoints, experiment content and absolute paths are excluded from public results, errors and Doctor output.

Experiment snapshots can contain source code and remain only in VS Code `globalStorageUri`; they are not synchronized or uploaded by this extension. Restore and Finalize refuse incomplete resource-level coverage. Remote extension hosts are rejected.

Version `0.4.0` adds no Agent-callable Git tools. User-only managed-worktree commands use `execFile` with fixed subcommands, validated full object IDs, branch names, repository roots and managed paths. They never fetch, pull, push, mutate remotes/config, prune worktrees or automatically delete worktrees. Promotion stops on target drift and never uses `reset --hard`; failed cherry-pick recovery is limited to `cherry-pick --abort` and otherwise enters a recovery-required state.

Version `0.5.0` allows capability-limited IDE autonomy: saving an existing document, provider formatting and pure-text Code Actions. These writes still require a trusted local workspace, an active user-started experiment, explicit instance/session IDs and fresh version/hash preconditions. `readOnly` is enforced by both the generated Codex tool list and extension handlers.

Version `0.5.1` clarifies zero-edit formatting as a no-op and adds a default-off acceptance Code Action fixture. The fixture only contributes a pure-text WorkspaceEdit for an explicit `*.bridgeaction` marker and does not bypass experiment, trust, policy, version or content-hash enforcement.

Version `0.6.1` permits an Agent to propose and manage bounded ordinary-experiment metadata. Starting requires an explicit instance/root/title/reason and user-confirmed per-root onboarding; every subsequent Agent write is blocked when the root is disabled or the machine policy is read-only. Agent tools cannot accept, restore, Finalize, abandon, pin, delete or manage worktrees. Workspace setup reports presence only, and onboarding writes only Bridge settings through the VS Code Configuration API. Interactive request cancellation is propagated to the extension before durable mutation. The memory-only Activity view excludes source, replacement text, hashes, terminal data, credentials and absolute paths. Editor reveal uses the fixed `showTextDocument` API before mutation and exposes no generic open/close command.

Version `0.7.0` replaces per-capability extension policy with an explicit master switch and accurate MCP annotations. Old restrictive v0.6 selections pause publication until the user chooses; disabling closes bridge sockets and removes the descriptor. Configuration writes use bounded JSON Pointer edits with existence/hash preconditions, block workspace-folder or remote-authority changes, and reject delayed execution in `explicit` mode. Resource changes are limited to existing local experiment roots, text and bounded directories; `.git`, traversal, symbolic links, junctions, binary mutation and arbitrary filesystem access remain unavailable.

Tasks can only be executed after workspace enumeration and fingerprint validation; MCP never supplies an arbitrary Task, command line or shell. Debug launch accepts only named static configurations. Debug Adapter Protocol access is a fixed whitelist with tracked session/frame/reference freshness, bounded pagination and workspace-scoped source breakpoints; generic `customRequest` is never exposed. Task commands/output, debug expressions/values and raw DAP messages never enter logs, Doctor, Activity or experiment Blobs. Task and Debug can have open-world side effects that local snapshots cannot reverse, and their MCP annotations declare that boundary.

Terminal access is observation-only. The MCP surface cannot create, focus, close or write to a terminal and cannot execute a command. Command lines and sanitized output depend on Shell Integration, remain in memory only, are bounded and report incomplete coverage. Untrusted or remote workspaces do not publish the bridge. Raw command lines/output never enter logs, Doctor, experiment snapshots or crash reports.

Version `0.8.0` adds no new workspace mutation. The authoritative catalog is public metadata. Local insight events are written per MCP process and contain only tool/category, timestamps, outcome, coarse latency and message-size buckets, truncation and stable error codes. They never retain parameters, results, paths, source, hashes, terminal content, debug expressions/values, environment variables or credentials; they remain local for at most 30 days and 20 MiB and are never uploaded.
