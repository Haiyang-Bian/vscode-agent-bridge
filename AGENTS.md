# Project guidance

## Toolchain

- Use Bun for dependency management, workspace scripts, builds, and tests.
- Run `bun run test:plan` or `bun run check:affected` before committing implementation changes.
- Keep all packages under `packages/` and share dependencies through Bun workspaces.

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
- Standalone test, audit and release-validation tasks create a new dated report under `docs/audits`; never rewrite an older report. Routine affected checks belong in the task handoff and commit message.

## Architecture

- Preserve two runtime layers: the MCP server and the VS Code extension.
- Keep wire contracts, schemas, and error codes in `packages/protocol`; it is a shared library, not a third service.
- Keep ordinary filesystem and shell operations out of the MCP surface. Expose IDE-native state and actions instead.
- Never add a generic wrapper around `vscode.commands.executeCommand` or an unrestricted terminal tool.
- Mutating tools must use document-version or content-hash preconditions and accurately advertise their side effects.

## Development workflow

- Prefer incremental changes over broad refactors.
- Add or update contract tests when the internal RPC protocol changes.
- Keep the test impact registry current when adding production modules, test domains, E2E scenarios or packaging boundaries.
- Record architecture and security decisions under `docs/adr/`.
- Create focused Git commits at meaningful milestones.
