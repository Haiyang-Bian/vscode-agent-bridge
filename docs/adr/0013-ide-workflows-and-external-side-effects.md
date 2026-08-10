# ADR 0013: IDE workflows and external side effects

- Status: Accepted
- Release: 0.7.0

## Context

VS Code Tasks and Debug services are the IDE-native way to build, test, run, and inspect software. A Task or debug target can nevertheless execute arbitrary project commands and affect state outside the workspace. Experiment snapshots cannot reverse services, databases, network requests, credentials, Git history, or arbitrary process effects.

## Decision

The bridge may enumerate and run only VS Code-managed, workspace-scoped Tasks. It may start only named launch configurations. Debug inspection and control use a fixed Debug Adapter Protocol request allow-list; arbitrary `customRequest` values are never accepted from MCP.

Experiment storage v2 recovers captured workspace-local text and resource structure. Resource mutation is confined to the selected experiment root and excludes `.git`, binary mutation, links, junctions, and reparse points. Recovery remains a user-confirmed operation.

Testing is represented by VS Code test Tasks. The extension does not depend on proposed APIs or internal commands to consume another extension's Testing tree.

## Consequences

- Task and debug execution are visible and auditable but not claimed to be non-destructive.
- The MCP client or supervising agent decides whether an annotated open-world operation requires approval.
- Coverage becomes partial when an operation modifies unsupported binary or external state; Finalize and restore must report that limitation honestly.

