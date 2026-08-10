# ADR 0004: Windows distribution and managed Codex configuration

- Status: Accepted
- Date: 2026-08-09

## Context

The prototype required Bun and a repository path in Codex configuration. Public installation must survive extension upgrades, avoid silently modifying user configuration, and keep the MCP process independent from VS Code's Extension Host.

## Decision

Release `0.2.0` as a `win32-x64` platform VSIX containing a `bun-windows-x64-baseline` compiled MCP executable. On explicit user confirmation, copy it to `%LOCALAPPDATA%/VSCodeAgentBridge/versions/<version>/` and configure its absolute command in the user-level Codex config.

The extension owns only a begin/end marked TOML block. Before writing, it parses the complete existing file, rejects malformed TOML or an unmanaged conflicting table, creates a timestamped backup, writes a same-directory temporary file and atomically replaces the original. Removing integration deletes only the marked block. Old version directories remain so an extension update cannot immediately invalidate a running Codex configuration.

The VSIX and standalone executable are generated artifacts rather than Git objects. CI rebuilds them from the frozen Bun lockfile, checks version alignment, audits archive contents and machine paths, publishes SHA-256 checksums, and creates GitHub provenance attestations. Marketplace publishing uses short-lived OIDC credentials behind an approval environment.

At decision time, official stable `@vscode/vsce@3.9.2` documents but does not implement `--oidc`; the workflow therefore pins Microsoft's exact `3.9.3-4` `next` build, whose CLI was verified to contain the option. Replace it with an exact stable OIDC-capable version when available and re-run all packaging gates.

## Consequences

The release is self-contained for Windows x64 and does not require a PAT in GitHub. It intentionally leaves old binaries on disk and requires an explicit command after upgrades. Other operating systems, Windows ARM64 and remote VS Code extension hosts remain unsupported until separately built and tested.
