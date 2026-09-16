# VS Code extension module

## Purpose

`packages/vscode-extension` is the IDE-native runtime. It publishes the local bridge, enforces trust and local-root policy, owns guarded direct operations, observes VS Code workflows and renders native UI.

`src/extension.ts` is the composition root. `BridgeHost` owns the authenticated RPC server. Request handlers validate and route typed calls; managers/services own behavior and state.

`src/installation.ts` verifies the bundled EXE and delegates install/uninstall/status to its bounded service CLI. The daemon owns login tasks and transactional HTTP configuration. Doctor reports HTTP health, service version/PID and task state; the extension never generates STDIO configuration or copies credentials to the clipboard.

## Capability map

| Capability | Primary implementation |
| --- | --- |
| Lifecycle, publication and policy | `extension.ts`, `bridge-host.ts`, `bridge-lifecycle.ts`, `private-registry-file.ts`, `windows-identity.ts`, `policies.ts`, `workspace-setup.ts`, `legacy-experiment-data.ts`, `codex-config.ts`, `installation.ts` |
| Editor, paths and language authorization | `editor-context.ts`, `language-services.ts`, `canonical-path-boundary.ts`, `document-access-controller.ts`, `document-access-grants.ts`, `request-handlers.ts` |
| Guarded text and resource changes | `change-set-manager.ts`, `resource-change-executor.ts`, `workspace-setup.ts` |
| Resource/configuration mutation | `resource-change-executor.ts`, `workspace-configuration-manager.ts`, `workspace-configuration-handlers.ts` |
| Terminal and Tasks | `terminal-observer.ts`, `terminal-capture.ts`, `task-manager.ts`, `task-request-handlers.ts`, `workflow-provenance.ts` |
| Debug | `debug-manager.ts`, `debug-request-handlers.ts`, `debug-output-capture.ts`, `workflow-provenance.ts` |
| Extension reflection and Marketplace | `extension-awareness-*`, `extension-marketplace-*`, `marketplace-client.ts`, `extension-maintainers.ts` |
| Current Profile and reviewed adapters | `extension-profile-*`, `extension-integration-*`, `python-environment-integration-core.ts` |
| Native UI and local insights | `bridge-hub-ui.ts`, `agent-activity*`, `output-source-order.ts`, `local-usage-insights.ts`, `legacy-experiment-data.ts` |

## Change rules

- Put orchestration in the composition root only when it wires owners together. Do not add another capability implementation directly to `extension.ts`.
- Keep handler validation, manager state transitions and UI confirmation boundaries distinct.
- Every Agent-visible mutation revalidates trust, exact selected root and stale-state preconditions immediately before applying effects.
- Normalize and contain paths using the shared path boundary; reject `.git`, links/reparse escapes and unsupported binary/resource cases where required.
- Task and Debug targets are open-world execution. Prepared definitions must bind instance/root, expose execution previews, hash the complete execution and run through fixed VS Code APIs. Persistence is a separate exact-hash/provenance operation.
- Extension inspection must not activate arbitrary extensions. Only a static reviewed adapter may activate its fixed extension for an explicit state request.
- Global Profile writes persist pending before apply and ambiguous recovery must fail Doctor health. Workspace writes use stale-state checks and immediate failure rollback without claiming durable snapshot recovery.
- Agent operations never open/focus editors as a precondition. Activity rendering is best effort, and only a user click may reveal the stored target.
- Legacy experiment storage is never loaded. User-confirmed cleanup is restricted to Bridge-owned metadata/snapshots and never touches Git branches or worktrees.

## Focused reading routes

- Lifecycle/configuration: the files in the first row plus ADR 0012 and ADR 0023.
- Direct edits/resources: change-set/resource/configuration managers plus ADR 0007, 0013, 0021 and 0023.
- Task/Debug/terminal: relevant manager, capture, handler and ADR 0009/0011/0013.
- Extension ecosystem: relevant manager/service/registry and ADR 0015–0017.

Read the nearest deterministic test before the E2E scenario. The impact registry maps these groups to lifecycle, direct-ide, task-terminal, debug, extension-ecosystem and ui-insights domains.
