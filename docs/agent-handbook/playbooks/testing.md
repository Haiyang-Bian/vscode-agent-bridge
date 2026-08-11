# Testing playbook

The authoritative policy is [the repository testing strategy](../../testing-strategy.md), implemented by `scripts/lib/test-impact.ts`. This page tells an Agent how to use that system during development.

## Default sequence

1. `bun run test:plan` — inspect paths, domains, risk, commands, E2E and artifact requirements without executing tests.
2. `bun run check:affected` — execute selected typechecks, deterministic tests and builds.
3. `bun run test:e2e:affected` or the exact selected scenario — only for mapped integration boundaries.

Manual `--domain` values may add investigation coverage. They never remove automatic coverage or a fail-closed upgrade.

## Gate choice

| Planner result | Agent action |
| --- | --- |
| Documentation only | Run the reported diff/documentation checks; no code/E2E gate |
| One affected domain | Run selected workspace checks and domain tests |
| Selected E2E scenarios | Run only those scenarios, including automatic prerequisites |
| `full` | Run the complete non-E2E `bun run check` once |
| Repeat E2E | Run two independent full Extension Host environments |
| Artifact | Build/test installed artifacts only at the packaging boundary |

Do not run full tests because work feels important, a function was completed or a commit is about to be created. A PR, merge, release, explicit user request, high-risk classification or fail-closed error is a valid trigger.

## Failure workflow

- Capture the exact stable error, failing test and environment distinction.
- Rerun only the smallest failing test after the first fix.
- Diagnose application defects separately from sandbox launch, dependency, VS Code cache/profile, Git fixture or packaging-install failures.
- Widen only if the root cause crosses a contract/runtime boundary or the smaller test cannot prove the repair.
- Do not turn a flaky failure into a passing result by immediately running the whole suite.

## Slow-gate protocol

Before full check, Extension Host E2E, repeat E2E or artifacts, state in commentary:

- the tier;
- the changed path/risk that triggered it;
- expected temporary profiles, processes, artifacts or settings;
- why deterministic/domain coverage is insufficient.

Do not rerun an unchanged passing slow gate. A rerun requires relevant code, test configuration or environment change, and the reason must be stated.

## Regression placement

- Schema/contract bug: protocol contract test.
- Pure store/sanitizer/planner bug: nearest Bun unit test.
- Handler/manager interaction that can be isolated: focused extension test.
- VS Code API, IPC, Task/terminal, Debug or Git-worktree behavior: selected E2E only when deterministic proof is unavailable.
- Packaged installation/layout bug: artifact smoke.

## Registry maintenance

Update `scripts/lib/test-impact.ts` and its tests when adding or moving production paths, tests, domains, E2E scenarios, root build configuration or packaging boundaries. All current production sources must remain classified. Rename/delete and missing-base behavior must continue to fail safely.
