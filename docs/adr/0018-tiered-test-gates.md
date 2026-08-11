# ADR 0018: Tiered test gates

- Status: Accepted
- Date: 2026-08-11

## Context

The repository grew from a small protocol bridge into protocol, MCP, Extension Host, recoverable experiment, Task, Debug, extension-orchestration and release layers. Tests were already organized by capability, but the execution interface offered mostly a single full workspace gate and one monolithic Extension Host E2E. Routine changes therefore paid release-like costs, while the E2E runner reused profile state and could skip cleanup on failure.

## Decision

Use one repository-owned impact registry to map changed paths to test domains, workspace checks, E2E scenarios, repeatability requirements and artifact boundaries.

Local development defaults to the affected plan. Full fast validation remains mandatory for shared contracts, security or lifecycle boundaries, persistent mutations, external-side-effect executors, multi-runtime changes and unknown production paths. Pull requests always run the full fast gate but select slow E2E and artifact work from the diff. `master` and releases retain complete gates.

Extension Host scenarios use unique workspace, registry, user-data and extensions roots. Lifecycle-only delays are not paid by ordinary scenarios. Runner failures propagate through exceptions so outer cleanup always executes.

Manual overrides may add domains or request full validation, but cannot remove required coverage.

## Consequences

Ordinary feedback becomes substantially faster and failures identify a smaller capability domain. The mapping registry becomes required maintenance when production paths or test boundaries change. Fail-closed classification preserves safety when the registry falls behind. Release assurance is unchanged and repeat E2E improves confidence that test state does not leak between runs.
