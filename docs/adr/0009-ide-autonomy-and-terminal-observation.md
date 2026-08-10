# ADR 0009: Capability-limited IDE autonomy and read-only terminal observation

- Status: Accepted
- Date: 2026-08-09
- Release: 0.5.0

## Context

The bridge originally required a user to review every Agent edit and deliberately left saving to the user. That boundary is safe, but it makes VS Code a passive review surface instead of the Agent's primary IDE. It also encourages clients to fall back to generic filesystem and shell tools for ordinary development work.

At the same time, a terminal often contains the best evidence about a build or long-running process. VS Code's stable terminal API can observe terminal and Shell Integration lifecycle events, but it cannot recover the complete historical buffer. Shell execution output is available only after the extension calls `TerminalShellExecution.read()`, so capture coverage must be represented explicitly.

## Decision

Protocol v4 introduces three machine-level autonomy profiles:

- `autonomous` is the default. Guarded IDE write tools can be approved at the MCP server level and may save existing documents.
- `review` retains per-write approval and requires an explicitly accepted checkpoint before ordinary experiment finalization.
- `readOnly` exposes only read operations and the extension rejects every Agent write even if a stale client configuration still lists one.

All Agent writes continue to require a trusted local workspace, an active experiment, explicit instance and session identifiers, and document version plus SHA-256 preconditions. The allowed write surface is limited to existing text documents: guarded edits, rename, save, provider formatting, and pure-text Code Actions. There is no generic command, filesystem, Git, task, debug, test, or terminal-input tool.

Terminal observation has an independent `allow`, `metadataOnly`, or `deny` policy. Untrusted workspaces always degrade to metadata-only regardless of the configured policy. The extension captures output only in memory, sanitizes ANSI and control sequences, caps each execution at 1 MiB and the window at 16 MiB, and reports missing prefixes and evictions instead of claiming complete coverage. Command lines, working directories, and output never enter logs, Doctor output, experiment blobs, or crash reports.

The default workflow is a normal user-created experiment branch plus automatic checkpoints and an eventual user-initiated Git squash. Managed Worktree remains an advanced isolation mode. Formal commits, history synchronization, push, and destructive cleanup remain user-only commands.

## Consequences

- Agents can complete common edit-format-fix-save loops through VS Code without receiving a console.
- Stale Codex configuration cannot grant broader access than the active extension policy.
- Terminal output is useful evidence but may be partial; every response carries coverage metadata.
- Extension restart loses terminal history by design.
- Resource operations and Code Actions containing commands remain unsupported, even when their command would normally be harmless.
- Users who need mandatory review can select `review`, and users who want a strict observation surface can select `readOnly`.
