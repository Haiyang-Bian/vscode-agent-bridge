# Testing strategy

The repository selects validation from change impact, failure consequence and execution cost. Targeted feedback is the default during development; complete gates remain mandatory at integration and release boundaries.

## Gate levels

| Level | Command | Purpose | Normal trigger |
| --- | --- | --- | --- |
| Affected | `bun run check:affected` | Selected workspace type checks, deterministic domain tests and builds | Local implementation commit |
| Domain | `bun run test:domain -- <domain...>` | Add focused coverage without weakening automatic selection | Investigation or regression repair |
| Full fast | `bun run check` | All workspace type checks, Bun tests and builds | High-risk change, PR, merge or classification failure |
| E2E scenario | `bun run test:e2e:scenario -- <scenario...>` | Selected real VS Code boundaries in an isolated profile | Affected integration boundary |
| E2E repeat | `bun run test:e2e:repeat` | Complete E2E twice with separate workspaces and profiles | E2E infrastructure, `master` and release |
| Artifact | package, checksum, bundle and artifact scripts | Installed and distributable product boundary | Packaging change, `master` and release |

`bun run test:plan` is read-only. By default it compares `HEAD` with staged, unstaged and untracked files. CI supplies `--base` and `--head`. `--format json` is suitable for other tools and `--format github` emits workflow outputs.

## Domains and escalation

The source of truth is `scripts/lib/test-impact.ts`. It maps production paths to protocol, MCP runtime, lifecycle, experiment/resource, Task/terminal, Debug, extension ecosystem, managed Git, UI/insights and release-tooling domains.

The following changes require the full fast gate: shared protocol production code; lifecycle and policy boundaries; recoverable persistence and mutation executors; Task and Debug executors; Git and Managed Worktree code; root manifests, lockfiles and compiler/build configuration; changes spanning runtime layers; and unknown production paths.

Unknown package production paths also require full E2E. E2E runner, harness, fixture or VS Code test-config changes require complete E2E twice. Packaging manifests, dependencies, installation assets and artifact scripts require the artifact gate. Documentation-only changes do not run code tests locally.

Root/nested `AGENTS.md` and `docs/agent-handbook` changes remain documentation-only but add `bun scripts/check-agent-handbook.ts` to validate required pages, local links, machine-specific paths and the default instruction-size budget.

Manual domains are additive. There is no supported flag for subtracting automatically selected coverage.

## E2E scenarios

The selectable scenarios are `core-language`, `lifecycle`, `experiment-resource`, `task-terminal`, `debug`, `extension-ecosystem`, `master-switch` and `managed-worktree`.

Every invocation creates a unique temporary workspace, registry, user-data directory and extensions directory. Ordinary scenarios use a 1 ms deterministic onboarding acceptance and no initialization delay. Only `lifecycle` retains the 10-second initialization and 11-second onboarding delays. Completion markers record requested and actual scenarios plus in-test cleanup state; the outer runner verifies the marker and deletes its complete temporary root before returning.

The runner may execute prerequisites for a requested scenario, but it must not execute unrelated target workflows. For example, Debug may prepare onboarding and an active experiment, but it does not run Task or resource-recovery assertions.

## Developer and agent workflow

1. Run `bun run test:plan` before deciding validation scope.
2. Run `bun run check:affected`, or the exact domain command shown by the plan.
3. When a test fails, diagnose and rerun the smallest failure. Widen only when the root cause crosses another domain.
4. Run the full fast gate once before a PR or when the plan reports `full`.
5. Run only the E2E scenarios selected by the plan. Do not substitute full E2E as a generic confidence check.
6. Do not rerun a passing unchanged gate. Record why a rerun became necessary.

Bug fixes place the first regression at the closest deterministic layer. E2E is reserved for behaviors that cannot be proven without the real Extension Host, IPC, VS Code API, Task/terminal, Debug adapter or Git worktree boundary.

Standalone testing, audit and release-validation work produces a new dated report under `docs/audits`. Routine implementation verification is recorded in the task handoff and commit message.

## CI policy

Every pull request runs `bun run check`. The PR diff then selects no E2E, individual scenarios, full E2E or full E2E twice. Artifact construction runs on a PR only when the impact plan marks a packaging boundary.

Every `master` push and version tag runs the complete fast gate, complete E2E twice and all artifact gates. Release tags additionally retain version verification, provenance, Marketplace policy and GitHub Release publication.
