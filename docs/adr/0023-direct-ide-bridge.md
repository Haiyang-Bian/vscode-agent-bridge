# ADR 0023: Direct IDE operations and user-focused extension UI

- Status: Accepted (implementation plan approved by the project owner)
- Date: 2026-09-16
- Release: 0.14.0
- Supersedes ADR 0005, ADR 0006 and ADR 0008. It supersedes the experiment/session requirements in ADR 0007, ADR 0010, ADR 0013 and ADR 0020 while retaining their stale-state, root, visibility and external-side-effect boundaries.

## Context

The experiment journal was introduced to separate dense recovery checkpoints from delivery history. In sustained Agent-driven development it became a mandatory workflow layer rather than a useful recovery boundary: ordinary edits, configuration, Tasks and Debug calls required an active session, while users rarely reviewed or restored its history. The same subsystem contributed seven MCP tools, most extension commands, a dedicated view, workspace onboarding settings and Managed Worktree orchestration.

Codex already owns repository edits, shell execution and Git delivery. The Bridge is most valuable where VS Code has authoritative state that another process cannot reproduce: unsaved buffers, diagnostics and language services, existing terminals, VS Code Tasks, Debug state, reviewed extension integrations and user-visible activity.

## Decision

Protocol v12 removes the experiment MCP domain, ordinary experiment storage and Managed Worktree product surface. The remaining 57 tools operate directly against an explicitly selected VS Code instance and workspace root. Mutation and execution continue to enforce trust, local-root containment, document versions and hashes, resource preconditions, definition fingerprints, short-lived one-use preparation handles, cancellation and accurate side-effect annotations. No generic filesystem, terminal-input, Git, VS Code command or Debug Adapter request capability is added.

Experiment identifiers, checkpoint identifiers, experiment titles and experiment rationales are removed from the remaining wire contracts. Prepared text/resource changes, extension installation plans and prepared Task/Debug definitions remain memory-only handles because they bind a reviewed candidate to exact state; they do not create a global active session. Successful operations report actual resulting state and do not claim durable recovery. Current-Profile configuration retains its independent bounded undo journal.

The extension no longer loads legacy experiment storage. It may detect the legacy directory and offer user-confirmed deletion of Bridge-owned metadata and snapshots, but it never deletes Git branches or worktrees. Existing worktrees remain ordinary user-managed Git state.

The Activity Bar contains Status and Agent Activity views. Pure reads do not create activity entries. Side-effecting work records bounded, sanitized metadata and an internal reveal target. Agent operations never change editor focus as a precondition; a user may reveal a target by selecting its activity entry. Local aggregate usage recording remains available through commands without a permanent view.

Protocol compatibility and release alignment are separate. Instance discovery reports the existing protocol `compatibility` plus whether the extension release is current, older, newer or unknown. A v12 daemon may list a v11 descriptor as incompatible but does not route calls to it.

Parsed Streamable HTTP requests rejected by an admission limit receive a request-correlated JSON-RPC server error. Authentication, Host, Origin and malformed messages remain HTTP-level failures. Session and global limits, cancellation ownership and the prohibition on retrying side effects remain unchanged.

Successful service installation retains only the active executable and one verified rollback candidate. Cleanup runs after the new daemon, login task and managed configuration have committed; it never removes a referenced or transactional candidate and cannot fail the running installation.

## Consequences

- Agents can call bounded IDE capabilities without creating or maintaining an experiment.
- Users see connection health and meaningful side effects without editor focus changes or permanent workflow dashboards.
- The Bridge no longer provides a snapshot timeline, acceptance workflow, automatic workspace restore or managed Git promotion.
- Source and workspace writes remain guarded against stale state, but completed writes may require ordinary editor, filesystem or Git recovery.
- Extension/server upgrades to 0.14.0 are coordinated because protocol v12 deliberately rejects older v11 extension runtimes.

## Relationship to retained decisions

ADR 0001 and ADR 0022 continue to define the two runtime layers and the per-user HTTP daemon. ADR 0012 continues to place approval decisions in the MCP client and retain the extension master switch. ADR 0011 continues to define cancellation and capture scope. ADR 0014 through ADR 0017 and ADR 0021 continue to define privacy, extension integration and path/identity boundaries.
