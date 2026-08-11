# VS Code extension module

## Purpose

`packages/vscode-extension` is the IDE-native runtime. It publishes the local bridge, enforces trust and policy, owns experiments and guarded mutations, observes VS Code workflows and renders native UI.

`src/extension.ts` is the composition root. `BridgeHost` owns the authenticated RPC server. Request handlers validate and route typed calls; managers/services own behavior and state.

## Capability map

| Capability | Primary implementation |
| --- | --- |
| Lifecycle, publication and policy | `extension.ts`, `bridge-host.ts`, `policies.ts`, `workspace-onboarding.ts`, `codex-config.ts`, `installation.ts` |
| Editor and language state | `editor-context.ts`, `language-services.ts`, `request-handlers.ts` |
| Experiments and guarded text changes | `experiment-manager.ts`, `experiment-store.ts`, `change-set-manager.ts`, `experiment-ui.ts` |
| Resource/configuration mutation | `resource-change-executor.ts`, `workspace-configuration-manager.ts`, `workspace-configuration-handlers.ts` |
| Terminal and Tasks | `terminal-observer.ts`, `terminal-capture.ts`, `task-manager.ts`, `task-request-handlers.ts` |
| Debug | `debug-manager.ts`, `debug-request-handlers.ts`, `debug-output-capture.ts` |
| Extension reflection and Marketplace | `extension-awareness-*`, `extension-marketplace-*`, `marketplace-client.ts`, `extension-maintainers.ts` |
| Current Profile and reviewed adapters | `extension-profile-*`, `extension-integration-*`, `python-environment-integration-core.ts` |
| Managed Git | `git-baseline.ts`, `git-path.ts`, `git-runner.ts`, `managed-worktree-manager.ts`, `managed-worktree-ui.ts` |
| Native UI and local insights | `bridge-hub-ui.ts`, `agent-activity*`, `agent-editor-visibility.ts`, `local-usage-insights.ts` |

## Change rules

- Put orchestration in the composition root only when it wires owners together. Do not add another capability implementation directly to `extension.ts`.
- Keep handler validation, manager state transitions and UI confirmation boundaries distinct.
- Every Agent-visible mutation revalidates trust, root, experiment/session ownership and stale-state preconditions immediately before applying effects.
- Normalize and contain paths using the shared path boundary; reject `.git`, links/reparse escapes and unsupported binary/resource cases where required.
- Task and Debug targets are open-world execution. Use fixed VS Code APIs, exact fingerprints/configurations and honest external-side-effect annotations.
- Extension inspection must not activate arbitrary extensions. Only a static reviewed adapter may activate its fixed extension for an explicit state request.
- Managed Git uses fixed argument vectors and exact paths. No shell, remote operation, hard reset, automatic push or broad cleanup.
- Persistent settings or profile changes need a recovery story; tests must restore global VS Code state even on failure.

## Focused reading routes

- Lifecycle/configuration: the files in the first row plus ADR 0012.
- Experiment/recovery: manager/store/executor plus ADR 0005–0007 and 0013.
- Task/Debug/terminal: relevant manager, capture, handler and ADR 0009/0011/0013.
- Extension ecosystem: relevant manager/service/registry and ADR 0015–0017.
- Managed worktree: manager, Git runner/path/baseline and ADR 0008.

Read the nearest deterministic test before the E2E scenario. The impact registry maps these groups to lifecycle, experiment-resource, task-terminal, debug, extension-ecosystem, managed-git and ui-insights domains.
