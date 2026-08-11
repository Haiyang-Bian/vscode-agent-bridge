# Tooling and release module

## Purpose

Root scripts make validation and distribution reproducible without adding another runtime layer. Bun owns local orchestration; GitHub Actions supplies explicit base/head revisions and release identity.

## Script map

| Boundary | Primary scripts |
| --- | --- |
| Impact planning and affected checks | `test-plan.ts`, `check-affected.ts`, `test-domain.ts`, `lib/test-impact.ts` |
| Full workspace orchestration | `check.ts`, `run-workspaces.ts` |
| Extension Host E2E | `run-extension-e2e.ts`, `test-e2e-affected.ts`, `lib/e2e-runner.ts` |
| Packaged VSIX E2E | `run-vsix-e2e.ts`, VS Code test configuration files |
| Build/package | `build-mcp-executable.ts`, `package-vsix.ts` |
| Release artifacts | `create-checksums.ts`, `create-test-bundle.ts`, `test-artifacts.ts`, `verify-release.ts` |
| Release environment | `lib/release-environment.ts` |
| Curated VS Code development environment | root `.code-workspace`, `.vscode/tasks.json`, `.vscode/launch.json`, `check-vscode-workspace.ts` |

## Ownership rules

- `lib/test-impact.ts` is the single source for domains, path coverage, risk, E2E scenario and artifact selection.
- Local planning reads staged, unstaged and untracked changes. CI always supplies explicit base/head revisions with enough Git history.
- Unknown production paths and classification failures widen gates. A manual domain cannot subtract required work.
- Full `check`, full E2E and release commands keep stable meanings; optimized commands are separate entry points.
- E2E runs create unique workspace, registry, user-data, extensions and managed-worktree roots. Only lifecycle pays lifecycle delay.
- Helpers throw errors. The outer runner owns exit status, marker verification and `finally` cleanup.
- Development-extension and packaged-VSIX runners share isolation behavior; packaged installation targets the temporary extensions directory, not a user default.
- The manual Extension Host debugger also uses a repository-local ignored profile. Shared Tasks never run on folder open and expose affected validation as the default.

## CI layers

- Pull requests: full fast check, affected E2E, and artifacts only for packaging boundaries.
- `master`: full fast check, two independent full E2E runs, residue checks and artifacts.
- Version tags: retain master assurance plus version/provenance/publication workflow.

See the [testing playbook](../playbooks/testing.md) for daily selection and [command reference](../reference/commands.md) for stable entry points.
