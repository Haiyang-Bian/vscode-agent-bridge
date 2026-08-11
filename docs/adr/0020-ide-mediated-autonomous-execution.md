# ADR 0020: IDE-mediated autonomous execution

- Status: Accepted
- Date: 2026-08-11
- Release: 0.12.0

## Context

The Bridge deliberately prefers IDE-native workflows over an out-of-band shell because VS Code
can expose the Agent's intent, execution lifecycle, terminal or Debug output and resulting
workspace checkpoint. Earlier releases described the boundary as an absence of shell execution,
while the combination of workspace configuration writes and Task or Debug launch could already
produce arbitrary process effects without a first-class provenance model.

The desired boundary is not a ban on shell commands. It is a ban on opaque execution that bypasses
the IDE and cannot be linked to the active experiment, the exact definition that was approved and
the evidence produced by the run.

## Decision

- Protocol v11 adds experiment-scoped prepared Task and Debug definitions. Prepared definitions
  are memory-only, expire after 30 minutes, are fingerprinted over their complete normalized
  execution specification and can be executed repeatedly while their owning experiment remains
  active.
- Agent Tasks may use VS Code ShellExecution or ProcessExecution, including an explicit shell
  command line. Agent Debug configurations may use any bounded JSON-compatible adapter
  configuration with a fixed `name`, `type` and `request`.
- Prepared Task execution uses `vscode.tasks.executeTask`; prepared Debug execution uses
  `vscode.debug.startDebugging`. The extension does not add another confirmation prompt. MCP
  clients own approval decisions using accurate open-world and destructive annotations.
- Every prepared or persisted definition is associated with an experiment, workspace root,
  definition fingerprint and Agent Activity record. Task/Debug execution records link the exact
  definition to VS Code lifecycle events, captured output and a final workspace checkpoint.
- Activity may display the complete normalized command, arguments and working directory. It may
  display environment-variable names but never their values. Command details do not enter usage
  insights, Doctor, ordinary logs or experiment content blobs.
- Prepared definitions may be persisted through dedicated tools with an exact configuration-file
  hash precondition. Persistence records provenance separately in extension workspace storage and
  never overwrites an unrelated same-name user definition.
- Generic workspace configuration mutation no longer writes Task or Debug definitions. It remains
  available for other configuration and is annotated for its worst-case open-world, partially
  recoverable effects.
- Bridge-authored deferred execution such as folder-open Tasks is removed. Existing deferred
  configuration is detected and reported but is never deleted automatically.
- Existing contributed Tasks remain executable. Shell and process executions receive complete
  fingerprints; opaque provider-defined execution is reported with incomplete fingerprint
  coverage instead of being represented as exact.
- Generated Debug `preLaunchTask` and `postDebugTask` relationships must reference a listed or
  prepared Task by identifier and fingerprint. Raw hidden Task labels are not accepted in a
  prepared Debug configuration.

## Consequences

- The Bridge can intentionally execute arbitrary local processes while preserving IDE visibility,
  attribution and bounded control. External process, network, database and environment effects
  remain unrecoverable.
- A supervising client may allow autonomous Task/Debug execution without VS Code prompting, or
  require approval using the tool annotations. The extension still enforces trust, experiment
  ownership, root scope and state preconditions.
- Terminal input, arbitrary VS Code commands, arbitrary DAP requests, Agent-callable Git and
  automatic push remain outside the MCP surface.
- The `aggressive` execution mode is retired. Explicit Agent invocation is autonomous; execution
  detached from the originating request is not.

## Relationship to earlier decisions

This decision extends ADR 0009, ADR 0012 and ADR 0013. Their experiment, client-approval and
external-side-effect boundaries remain in force; statements that the Bridge has no Task, Debug or
shell-backed execution describe their earlier releases rather than the v0.12 surface.
