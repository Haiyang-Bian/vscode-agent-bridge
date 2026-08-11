# VS Code extension guidance

Read the [VS Code extension module guide](../../docs/agent-handbook/modules/vscode-extension.md) and the relevant capability route before changing this package.

- `src/extension.ts` is the composition root. Keep behavior in focused managers/services and transport validation/error mapping in handlers or `BridgeHost`.
- Every Agent-visible mutation must enforce workspace trust, exact root scope, active experiment ownership and the relevant version/hash/fingerprint/revision preconditions.
- Do not add generic command execution, arbitrary DAP requests, terminal input, unrestricted path operations or Agent-callable Git. Fixed VS Code-native boundaries must remain explicit and auditable.
- Preserve user-only confirmation boundaries and report external or unsupported side effects honestly; experiment snapshots cannot recover services, databases, networks, environment changes or Git history.
- Treat descriptor publication, onboarding, policy, persistent stores, Task/Debug execution, resource mutation and managed worktrees as high-risk lifecycle or side-effect boundaries.
- Tests that modify VS Code global state must restore it in `try/finally`. E2E helpers throw to the outer runner so the isolated profile is always cleaned.
- Start with `bun run test:plan`; choose the mapped domain and E2E scenario rather than scanning or running the complete suite by default.
