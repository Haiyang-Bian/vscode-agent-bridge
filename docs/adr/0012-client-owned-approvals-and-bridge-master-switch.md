# ADR 0012: Client-owned approvals and the bridge master switch

- Status: Accepted
- Release: 0.7.0

## Context

The bridge previously mapped three extension autonomy profiles into Codex MCP approval modes and also enforced a separate terminal-read policy. That duplicated policy between the MCP client and the VS Code extension, produced avoidable prompts, and made supervising-agent approval difficult to reason about.

## Decision

The extension exposes one machine-level master switch and accurately annotates every MCP tool. Codex or another MCP client owns server-level and per-tool approval. `Configure Codex` does not write `default_tools_approval_mode`.

An `explicit` execution mode rejects Bridge-authored deferred Task execution. An opt-in `aggressive` mode permits deferred IDE workflows. Neither mode bypasses workspace trust, experiment ownership, root containment, state preconditions, or the ban on generic VS Code commands and terminal input.

Legacy restrictive settings are never silently broadened. A user who explicitly selected read-only or restricted terminal access must resolve a one-time migration before the v0.7 bridge publishes an instance.

## Consequences

- Approval UX can evolve in Codex without duplicating it in the extension.
- Task, debug, evaluate, and termination tools must advertise potential destructive and open-world effects.
- Turning off the bridge prevents future MCP access but cannot undo persistent workspace configuration already written by an earlier experiment.

