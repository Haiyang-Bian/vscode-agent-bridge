# Project guidance

## Toolchain

- Use Bun for dependency management, workspace scripts, builds, and tests.
- Run `bun run check` before committing implementation changes.
- Keep all packages under `packages/` and share dependencies through Bun workspaces.

## Architecture

- Preserve two runtime layers: the MCP server and the VS Code extension.
- Keep wire contracts, schemas, and error codes in `packages/protocol`; it is a shared library, not a third service.
- Keep ordinary filesystem and shell operations out of the MCP surface. Expose IDE-native state and actions instead.
- Never add a generic wrapper around `vscode.commands.executeCommand` or an unrestricted terminal tool.
- Mutating tools must use document-version or content-hash preconditions and accurately advertise their side effects.

## Development workflow

- Prefer incremental changes over broad refactors.
- Add or update contract tests when the internal RPC protocol changes.
- Record architecture and security decisions under `docs/adr/`.
- Create focused Git commits at meaningful milestones.
