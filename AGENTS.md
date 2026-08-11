# Project guidance

## Start with the handbook

- For non-trivial work, read the [Agent development handbook](docs/agent-handbook/README.md), choose the matching task route, and then read only the linked module or playbook pages.
- Also read the closest nested `AGENTS.md` for the package or directory being changed. Closer instructions add to or override this file.
- Do not begin by traversing the entire repository. Start with the handbook route, exact symbols, their callers and their nearest tests. Widen only when evidence shows the change crosses another boundary.
- Treat live code, manifests and tests as current implementation truth; Accepted ADRs as architectural decision truth; and the handbook as a maintained synthesis and router. Reconcile conflicts instead of silently choosing one.

## Toolchain

- Use Bun for dependency management, workspace scripts, builds and tests.
- Keep packages under `packages/` and share dependencies through Bun workspaces.
- Prefer incremental changes over broad refactors. A broad refactor requires explicit user review.
- Create focused Git commits at meaningful milestones.

## Non-negotiable architecture and security

- Preserve two runtime layers: the MCP server and the VS Code extension. `packages/protocol` is their shared library, not a third service.
- Keep wire contracts, schemas, tool metadata, protocol versions and stable error codes in `packages/protocol`.
- Keep ordinary filesystem and shell operations out of the MCP surface. Expose bounded IDE-native state and actions instead.
- Never add a generic wrapper around `vscode.commands.executeCommand`, arbitrary Debug Adapter requests, terminal input or unrestricted filesystem/Git operations.
- Mutating tools require the applicable workspace-trust, root, experiment/session, document-version, content-hash, fingerprint or revision preconditions and must accurately advertise side effects and recovery limits.
- Preserve user-only boundaries for acceptance, recovery, managed-worktree promotion and other explicitly confirmed operations.

## Testing gates

- Start non-trivial validation with `bun run test:plan` or `bun run check:affected`. Do not run a full gate merely because a function or commit was completed.
- Run `bun run check` only when the impact plan reports `full`, when preparing a pull request, merge or release, when the user explicitly requests it, or when classification fails closed.
- Run only the E2E scenarios selected by the impact plan. Full E2E is reserved for high-risk changes, E2E infrastructure, pull-request requirements, `master`, releases or an explicit user request.
- Do not build release artifacts, checksums or cross-machine bundles during ordinary development validation.
- After a failure, rerun the smallest failing test and diagnose it before widening the gate.
- Do not rerun an unchanged passing gate unless relevant code, test configuration or the execution environment changed; state the reason before rerunning.
- Add the nearest deterministic regression test for a bug. Add E2E coverage only for a process, VS Code API or other real integration boundary.
- Before a slow or full gate, explain its tier, trigger, expected side effects and why a smaller gate is insufficient.
- A manual `--domain` may add coverage but must never suppress required domains or a fail-closed upgrade.

## Documentation and decisions

- Record architecture and security decisions under `docs/adr/`; update the handbook when a decision changes its project or module map.
- Keep `scripts/lib/test-impact.ts` current when adding production modules, test domains, E2E scenarios or packaging boundaries.
- Standalone test, audit and release-validation tasks create a new dated report under `docs/audits`; never rewrite an older report. Routine affected checks belong in the task handoff and commit message.
- Follow [handbook maintenance](docs/agent-handbook/maintenance.md) when changing the handbook or introducing a new subsystem.
