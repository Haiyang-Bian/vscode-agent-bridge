# VS Code Agent Bridge

VS Code Agent Bridge connects local MCP clients such as Codex to IDE-native, read-only VS Code state. It is intentionally split into two runtime layers: a standalone STDIO MCP server and a VS Code desktop extension. `packages/protocol` contains their shared RPC contracts and is not a third service.

The `0.2.0` release targets Windows x64. Marketplace users do not need Bun, Node.js, or this repository: the platform-specific VSIX contains a Bun-compiled MCP executable and the extension installs a versioned copy on explicit request.

## Read-only tools

| Tool | Purpose |
| --- | --- |
| `vscode_list_instances` | Discover live local VS Code windows without exposing credentials or IPC endpoints. |
| `vscode_get_editor_context` | Read active/visible editor, selection, dirty state, document version, trust and workspace context. |
| `vscode_read_document` | Read a VS Code buffer, including unsaved content, with bounded range and truncation metadata. |
| `vscode_get_diagnostics` | Read normalized active-document, document or workspace diagnostics. |
| `vscode_get_document_symbols` | Read a flattened symbol tree with stable hierarchy fields. |
| `vscode_get_definitions` | Resolve definitions for an explicit URI and zero-based position. |
| `vscode_get_references` | Resolve sorted, deduplicated references. |
| `vscode_get_hover` | Read bounded hover text with command links redacted. |

There is no generic VS Code command tool, terminal tool, filesystem wrapper or editor mutation in this release. Remote SSH, WSL, Dev Containers, Codespaces and non-Windows platforms are not supported by `0.2.0`.

## Repository layout

```text
packages/
  protocol/          RPC schemas, error codes and discovery contracts
  mcp-server/        standalone STDIO MCP server launched by Codex
  vscode-extension/  VS Code desktop UI extension and installer
scripts/             Bun build, test, package and release verification
docs/adr/            architecture and security decisions
docs/acceptance/     clean-machine Windows acceptance procedure
```

## Development

Install Bun 1.3.11 and Node.js 22 or newer. Node is used only by Microsoft's official `vsce`; Bun owns dependency installation, workspace builds and tests.

```powershell
bun install --frozen-lockfile
bun run check
bun run test:e2e
bun run package:vsix
bun run test:artifact
```

`bun run check` performs type checking, Bun unit/contract tests and workspace builds. `test:e2e` runs the extension inside an isolated real VS Code Extension Host. `package:vsix` compiles the Windows x64 baseline EXE, packages a platform-specific VSIX and audits its contents. Generated release files are written to `artifacts/`.

## Release

Pull requests and `master` run [CI](.github/workflows/ci.yml). A `v0.2.0` tag runs [the release workflow](.github/workflows/release.yml), creates SHA-256 checksums and provenance, publishes a GitHub Release, and publishes to Marketplace through `vsce --oidc` after approval of the `marketplace` environment.

Publisher creation and the Marketplace Trusted Publishing policy are one-time account operations; no PAT is stored in this repository. See [the release checklist](docs/releases/v0.2.0.md) and [cross-machine acceptance prompt](docs/acceptance/windows-x64-cross-machine.md).

## Security and license

The extension uses a per-window random identifier and token over local IPC. Descriptor files are atomically replaced, live-probed and never returned through MCP with authentication material. Codex configuration changes are marker-scoped, TOML-validated, backed up and atomically replaced.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). This project is licensed under the [MIT License](LICENSE).
