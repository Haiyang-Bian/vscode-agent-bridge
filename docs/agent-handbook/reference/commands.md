# Command reference

`package.json` is authoritative. This page summarizes stable intent; verify arguments in the owning script when changing behavior.

## Development and validation

| Command | Meaning | Typical side effects |
| --- | --- | --- |
| `bun run test:plan` | Read-only impact classification for local diff or explicit revisions | Git reads only |
| `bun run check:affected` | Selected workspace typecheck/build and domain tests | Build outputs/test fixtures |
| `bun run test:domain -- <domain...>` | Add one or more focused domains | Test fixtures |
| `bun run check` | Full typecheck, all non-E2E tests and all workspace builds | Workspace build outputs |
| `bun scripts/check-agent-handbook.ts` | Validate handbook structure, links and scoped instruction size | Read-only repository scan |
| `bun scripts/check-vscode-workspace.ts` | Validate shared VS Code roots, Tasks, launch profiles and recommendations | Read-only repository scan |
| `bun run test:e2e:smoke` | Isolated `core-language` Extension Host scenario | Temporary profile/processes |
| `bun run test:e2e:scenario -- <scenario...>` | Explicit selected Extension Host scenarios | Temporary profile/processes/settings restored by test |
| `bun run test:e2e:affected` | E2E selected from the same impact registry | Depends on plan; may skip |
| `bun run test:e2e` | One complete isolated Extension Host run | Slow temporary profile/processes |
| `bun run test:e2e:repeat` | Two independent complete E2E runs plus cleanup assertions | Slow; two temporary environments |

Planning options include `--base`, `--head`, additive `--domain`, `--full` and `--format text|json|github`. CI uses explicit revisions; local mode includes staged, unstaged and untracked changes.

## Build and release

| Command | Meaning |
| --- | --- |
| `bun run build` | Build every workspace |
| `bun run build:mcp:exe` | Compile the platform MCP executable |
| `bun run package:vsix` | Build and audit the side-loaded VSIX |
| `bun run release:checksums` | Generate release artifact hashes |
| `bun run package:test-bundle` | Build the cross-machine Windows test bundle |
| `bun run verify:release` | Verify release version/environment invariants |
| `bun run test:artifact` | Validate release metadata, installed packaged VSIX HTTP E2E, singleton EXE and isolated login-task installation |

Artifact commands are not ordinary development checks. Run them only when the impact plan marks the packaging boundary, on `master`/release, or by explicit request.

## Direct focused tests

`bun scripts/test-http-service.ts` exercises real isolated Windows login tasks using the built EXE. It belongs to the artifact gate. `bun run test:e2e:scenario -- http-bridge` tests shared HTTP clients against the actual Extension Host, including cancellation before delayed onboarding can modify settings. Local product commands are documented in [installation and recovery](../../installation.md).

Prefer the exact changed test during diagnosis, for example `bun test <test-file>`. After it passes, return to the impact-selected command. Do not use an ad hoc direct test to claim a required wider gate passed.
