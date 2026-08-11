# Repository tooling guidance

Read [tooling and release](../docs/agent-handbook/modules/tooling-and-release.md) and the [testing playbook](../docs/agent-handbook/playbooks/testing.md) before changing scripts.

- Bun owns workspace orchestration. Keep scripts deterministic, non-interactive where practical and explicit about files and side effects.
- The impact classifier fails closed: Git failures, unknown production paths and classifier exceptions must widen validation rather than report no work.
- Manual domains may only add coverage. Preserve the existing full meanings of `bun run check`, `bun run test:e2e` and release commands.
- E2E and artifact runs use unique workspace, registry, user-data and extensions roots. Helpers must throw rather than call `process.exit()`; the outermost runner owns exit status and `finally` cleanup.
- Packaging logic must verify the actual installed/package boundary and must not leak installation into a default user profile.
- The shared VS Code workspace must keep the repository plus all three package roots so folder-bound extensions activate. Hide overlapping package trees from the repository root view, and make every shared Task name the `Repository` working directory explicitly.
- Shared VS Code Tasks and launch profiles must use fixed commands, never run on folder open and keep manual Extension Host state under the ignored repository-local test profile.
- Add focused tests for classification, scheduling, cleanup and release-environment behavior when those paths change.
- Script and E2E-infrastructure changes may trigger full, repeat or artifact gates. Announce the selected slow tier before running it; do not override the classifier.
- Run `bun scripts/check-vscode-workspace.ts` after editing `.code-workspace` or `.vscode` development configuration.
