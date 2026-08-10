# ADR 0010: Workspace reflexivity and visible Agent activity

- Status: Accepted
- Date: 2026-08-10
- Release: 0.6.0

## Context

Agent experiments currently begin only through a user command, while the Agent can observe only the active session. A user also sees checkpoints after edits, but receives little real-time indication of which guarded IDE operation is running or which documents it targets. Making the bridge more autonomous without making it more legible would weaken user control.

Workspace settings, launch configurations, tasks and `.code-workspace` files are also security-sensitive configuration surfaces. Version 0.6 needs to discover them for onboarding without prematurely exposing a generic configuration or filesystem writer.

## Decision

Protocol v5 adds bounded reflection tools for workspace setup and ordinary experiment metadata. An Agent may inspect setup, list experiments, start one ordinary experiment with a user-visible task title, rename ordinary sessions with an expected-title precondition, and create explicit checkpoints. Acceptance, restore, finalization, abandonment, deletion, pinning and every Managed Worktree operation remain user-only.

The first experiment-related action inspects the selected local workspace folder and asks the user before creating `.vscode` or changing folder settings. The extension stores only durable enablement and editor-visibility policy in workspace settings. Session identifiers, names and lifecycle state remain in extension global storage. Configuration discovery reports presence and readability only; it never returns configuration contents.

Agent text mutations reveal their target documents through `window.showTextDocument` before applying changes. The default opens every target and focuses the first, while a resource-scoped setting can choose a different presentation or disable it. A native, memory-only activity feed shows bounded operation metadata and never retains source text, hashes, terminal data, tokens or absolute paths.

## Consequences

- Agents can name and maintain their own recoverable ordinary sessions without gaining formal acceptance or Git authority.
- Users explicitly opt a workspace folder into Agent experiments, and a stale MCP configuration cannot bypass either workspace or machine policy.
- Text changes become visible before mutation, but users can opt out or close editors without the extension reopening them after completion.
- Activity is intentionally ephemeral; checkpoints remain the durable source of experiment history.
- Structured configuration editing, Task execution and Debug control remain future protocol additions.
