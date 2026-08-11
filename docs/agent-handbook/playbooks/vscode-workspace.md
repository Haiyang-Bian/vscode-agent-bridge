# VS Code workspace

Open `vscode-agent-bridge.code-workspace` instead of the bare folder for the curated development experience:

```powershell
code vscode-agent-bridge.code-workspace
```

## Root layout

The workspace intentionally exposes four named roots:

| Root | Purpose |
| --- | --- |
| `Repository` | Git, documentation, CI and repository-wide scripts |
| `MCP Server` | MCP runtime package and package-root extension activation |
| `Protocol` | Shared schemas, contracts and error codes |
| `VS Code Extension` | Extension manifest, source, fixtures and Extension Host debugging |

The three package directories overlap the repository root on disk because some VS Code extensions detect projects at a workspace-folder boundary. To keep Explorer and search results readable, those package subtrees are hidden only from the `Repository` view and remain visible through their dedicated roots. Tasks always name `Repository` explicitly, so the active editor's root cannot silently change command working directories.

## Workspace behavior

- Uses VS Code's built-in TypeScript language service. The repository's TypeScript 7 package is compiler-only and remains authoritative through `bun run typecheck`; do not point `typescript.tsdk` at it.
- Disables automatic npm/tsc Task discovery so generated fixtures and package scripts do not flood the Task picker.
- Disables automatic folder-open Tasks and JavaScript auto-attach.
- Excludes dependencies, builds, artifacts and Extension Host profiles from search/watch; generated directories stay accessible through explicit paths or the terminal.
- Recommends the Bun, EditorConfig, Markdownlint and GitHub Actions extensions without installing anything automatically.
- Applies the Bridge resource settings at workspace scope so all four roots behave consistently; `.vscode/settings.json` remains the bare-folder fallback. No user-global settings are written.

## Curated Tasks

Use **Tasks: Run Task** or the normal build/test shortcuts:

| Task | Intended use |
| --- | --- |
| `Bridge: Plan affected validation` | Read the impact decision without running tests |
| `Bridge: Check affected` | Default development test task |
| `Bridge: Build all` | Default build task and Extension Host pre-launch task |
| `Bridge: Typecheck all` | Explicit all-workspace type checking |
| `Bridge: Test active file` | Smallest deterministic test during diagnosis |
| `Bridge: Test domain...` | Pick one additive test domain |
| `Bridge: Handbook check` | Validate Agent guidance structure and links |
| `Bridge: E2E smoke` / `E2E scenario...` | Explicit selected Extension Host boundaries |
| `Bridge: Full check (high risk / PR)` | Classifier/PR boundary only |
| `Bridge Release: ...` | Packaging/release boundary only |

Slow and release Tasks are deliberately labeled and are never defaults. Agent testing rules still govern when they may run.

## Debug configurations

- `Bridge: Extension Host` builds first, then launches the development extension with a persistent but repository-local profile under ignored `.vscode-test/manual/`. It never reuses the normal VS Code user-data or extensions directory.
- `Bridge: Debug active Bun test` runs the active test through the Bun debugger.
- `Bridge: Debug active Bun file` runs the active TypeScript/JavaScript file through the Bun debugger.

Bun debugger support requires the recommended `oven.bun-vscode` extension and is a developer convenience. Command-line tests remain the validation authority.

## Maintenance

Run `bun scripts/check-vscode-workspace.ts` after changing the workspace, Tasks, launch configurations or folder settings. The checker enforces the four named roots, de-duplicated root view, fixed Bun Task boundary and working directory, no folder-open execution, isolated Extension Host profile, required recommendations and absence of machine-specific paths. These shared files intentionally remain strict JSON (a valid JSONC subset) so the checker needs no extra parser dependency.
