# ADR 0016: Marketplace and current-Profile orchestration

## Status

Accepted for v0.10.0.

## Context

The Bridge can observe installed extension capabilities, but an Agent still cannot discover a missing language/debug tool or configure an installed extension through IDE-native boundaries. VS Code exposes installed extensions and configuration through stable APIs, but it does not expose a stable public installation API or the private identity of the active Profile.

## Decision

- Query only the fixed Visual Studio Marketplace Gallery HTTPS endpoint through a bounded compatibility client. Validate the response envelope and fields, honor an explicit HTTP/HTTPS proxy with normal TLS verification, cap time and bytes, and fail closed.
- Treat `official` as a claim from a versioned, reviewed publisher directory maintained by this project. Report Marketplace domain verification separately; it is not a security verdict.
- Split installation into expiring candidate and plan handles. Lock a stable ID/version/publisher plus a completely resolved dependency/extension-pack graph of at most 20 members. Revalidate every member immediately before apply.
- Use only the reviewed VS Code native `workbench.extensions.installExtension` command after runtime capability detection. Preserve VS Code Publisher Trust and reload UI. Never fall back to CLI, URLs, arbitrary VSIX files, downgrade, uninstall, update or a generic command bridge.
- If the native boundary is unavailable, use only the fixed extension-details command and return `userActionRequired`. If trust or reload cannot be proven complete, report a pending state rather than success.
- Manage only the current window's active Profile. Do not read private Profile databases, names or IDs. New Profile creation remains user-driven through VS Code's native Profiles manager.
- Read and update only non-sensitive keys declared by an installed extension manifest. Require a canonical target-value SHA-256 and validate declared type, enum and scope before every update.
- Record Global changes in a local 30-day/100-entry undo journal. Store only non-sensitive declared values needed for undo, never log or expose them in Activity/Doctor/errors. Workspace and WorkspaceFolder changes remain recoverable experiment checkpoints.

## Consequences

The Agent can discover and prepare ecosystem capabilities while installation trust remains visibly owned by VS Code. Exact Marketplace versions can change between prepare and apply, so the operation may deliberately expire. A native command is an internal compatibility boundary rather than a stable API; runtime detection, source-boundary tests and post-install version verification are mandatory. Global configuration is not restored by experiment snapshots, so its separate guarded journal is explicit and limited.
