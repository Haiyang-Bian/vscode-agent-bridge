# Architecture decision index

Read only the decisions that constrain the task. Accepted ADRs are authoritative over summaries in this handbook.

| ADR | Decision | Read when changing |
| --- | --- | --- |
| [0001](../../adr/0001-two-runtime-layers.md) | Two runtime layers with shared protocol | Package boundaries, transport, remote support |
| [0002](../../adr/0002-local-security-boundary.md) | Local authentication and security boundary | Descriptor, IPC, trust, secrets, generic capability bans |
| [0003](../../adr/0003-tool-contracts.md) | Tool contracts and rollout order | MCP surface, schemas, errors, bounds, mutations |
| [0004](../../adr/0004-windows-distribution-and-managed-codex-config.md) | Windows distribution and managed Codex config | VSIX, executable install, Codex configuration |
| [0005](../../adr/0005-experiment-history.md) | Experiment history | Checkpoints, acceptance, restore/finalize semantics |
| [0006](../../adr/0006-experiment-storage.md) | Content-addressed local experiment storage | Persistence, leases, retention, snapshots |
| [0007](../../adr/0007-guarded-change-sets.md) | Guarded change sets | Text mutation, version/hash preconditions |
| [0008](../../adr/0008-managed-worktrees-and-promotion.md) | Managed worktrees and one-commit promotion | Git isolation, synchronization, promotion, cleanup |
| [0009](../../adr/0009-ide-autonomy-and-terminal-observation.md) | IDE autonomy and terminal observation | Workflow modes, terminal capture and visibility |
| [0010](../../adr/0010-workspace-reflexivity-and-visible-agent-activity.md) | Workspace reflexivity and visible Agent activity | Onboarding, workspace state, Agent UI visibility |
| [0011](../../adr/0011-request-cancellation-readiness-and-capture-scope.md) | Cancellation, readiness and capture scope | RPC cancellation, lifecycle, bounded output |
| [0012](../../adr/0012-client-owned-approvals-and-bridge-master-switch.md) | Client approvals and bridge master switch | Policy, annotations, legacy migration, publication |
| [0013](../../adr/0013-ide-workflows-and-external-side-effects.md) | IDE workflows and external effects | Tasks, Debug, resource recovery limits |
| [0014](../../adr/0014-privacy-preserving-local-usage-insights.md) | Privacy-preserving local usage insights | Metrics, retention, export, suggestions |
| [0015](../../adr/0015-extension-awareness-and-observable-ide-signals.md) | Extension awareness and observable IDE signals | Extension metadata, Output/Problems/Debug capture |
| [0016](../../adr/0016-marketplace-and-current-profile-orchestration.md) | Marketplace and Current Profile orchestration | Search/install/configuration and Publisher Trust |
| [0017](../../adr/0017-reviewed-extension-adapters.md) | Reviewed extension adapters | Extension activation, compatibility, Python adapter |
| [0018](../../adr/0018-tiered-test-gates.md) | Tiered test gates | Impact registry, E2E isolation, CI validation |
| [0019](../../adr/0019-progressive-agent-handbook.md) | Progressive-disclosure Agent handbook | Instruction scope, handbook layers, maintenance and validation |
| [0020](../../adr/0020-ide-mediated-autonomous-execution.md) | IDE-mediated autonomous execution | Prepared/persisted Task and Debug definitions, provenance, deferred execution |
| [0021](../../adr/0021-canonical-path-document-grants-and-windows-identity.md) | Canonical paths, document grants and Windows identity | Path containment, external language reads, descriptor ACLs |
| [0022](../../adr/0022-per-user-http-daemon.md) | Per-user HTTP MCP daemon | Singleton ownership, sessions, cancellation, credentials, logon startup and migration |

Create a new ADR rather than rewriting an Accepted decision when the project deliberately changes direction. Link superseding and superseded records in both directions.
