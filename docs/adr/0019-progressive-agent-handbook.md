# ADR 0019: Progressive-disclosure Agent development handbook

- Status: Accepted
- Date: 2026-08-11

## Context

The repository now spans two runtimes, a shared protocol, many IDE workflow capabilities, release tooling and eighteen prior architecture decisions. A single root instruction file cannot explain all of that without consuming the Agent instruction budget, becoming stale or encouraging every task to scan the whole repository.

Codex discovers `AGENTS.md` hierarchically from the repository root toward the working directory, with closer files taking precedence and a bounded combined instruction size. Detailed project explanation therefore needs a separate, opt-in knowledge layer.

## Decision

Use three progressive-disclosure layers:

1. Root `AGENTS.md` contains repository-wide non-negotiable rules and directs non-trivial work to the handbook.
2. Package and tooling `AGENTS.md` files contain concise local invariants that load only when work occurs in that scope.
3. `docs/agent-handbook/` contains task routing, project/architecture synthesis, module ownership, playbooks and references that Agents read on demand.

Live code, manifests and tests remain implementation truth. Accepted ADRs remain architectural decision truth. The handbook is a maintained synthesis and router; audits remain dated evidence rather than current status.

A repository checker validates required handbook pages, relative links, machine-specific path leakage and scoped instruction-chain size. The impact registry treats handbook and `AGENTS.md` changes as documentation work and adds this checker without widening to product tests.

## Consequences

- Agents can orient by task and module without preloading the repository or every ADR.
- Mandatory rules remain visible even when explanatory pages are not loaded.
- New modules, domains, commands and decisions create an explicit handbook-maintenance obligation.
- The handbook can drift, so automated structural checks and source-of-truth links are required; the checker cannot prove every prose claim is semantically current.
- A future change to instruction layout should supersede this ADR rather than silently collapsing the layers back into one large file.
