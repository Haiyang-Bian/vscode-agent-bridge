# Project overview

## Mission

VS Code Agent Bridge gives MCP clients bounded access to IDE-native VS Code state and workflows. It allows arbitrary command specifications only as observable, fingerprinted VS Code Task/Debug workflows; it is not a terminal-input, unrestricted filesystem or IDE-bypassing shell API.

The product separates a conventional STDIO MCP endpoint from the VS Code Extension Host. The bridge adds value where the IDE has authoritative state: unsaved buffers, language services, diagnostics, experiments, visible/captured IDE output, Tasks, Debug, extension metadata and guarded workspace changes.

## Current snapshot

This page was last reconciled on 2026-08-11. Verify drift-sensitive values at their source before changing release or compatibility behavior.

| Fact | Current snapshot | Authoritative source |
| --- | --- | --- |
| Package version | 0.12.0 candidate | root and workspace `package.json` files |
| Internal bridge protocol | v11 | `packages/protocol/src/constants.ts` and version tests |
| MCP surface | 64 catalog-derived tools | `packages/protocol/src/tool-catalog.ts`, startup registration assertion and STDIO tests |
| Primary distribution | Side-loaded Windows x64 VSIX with bundled MCP executable | root README and release scripts |
| Supported runtime context | Local desktop VS Code workspace | ADR 0001 and runtime policy |
| Dependency/build owner | Bun workspaces; Node only where the official packaging tool requires it | root `package.json` and README |

This is an engineering candidate with a broad implemented surface, not evidence that every security or release boundary is complete on every machine. Treat audit findings as dated evidence and re-verify live code before claiming a finding is still open or fixed.

## Product invariants

- The Agent selects an explicit live VS Code instance; discovery never returns bearer credentials or IPC endpoints, and old protocols remain sanitized incompatible entries.
- The extension owns VS Code API access, workspace trust and mutation enforcement.
- Reads are bounded and report truncation or incomplete coverage.
- Writes use experiments plus the strongest applicable concurrency precondition.
- Recoverability claims cover captured workspace text/resource state, not arbitrary external effects.
- User-confirmed operations remain user-confirmed; MCP annotations describe side effects but do not replace client approval policy.
- Shell/Process execution is allowed only through IDE-visible Task/Debug definitions whose complete execution fingerprint is revalidated at start.

## Repository map

```text
packages/
  protocol/          shared schemas, errors, RPC framing and tool catalog
  mcp-server/        STDIO MCP runtime, instance discovery and RPC client
  vscode-extension/  Extension Host runtime, managers, handlers and native UI
scripts/             affected-test, E2E, build, package and release orchestration
docs/
  agent-handbook/    progressive Agent orientation and development playbooks
  adr/               accepted architecture and security decisions
  releases/          release intent and version-specific closeout
  acceptance/        executable clean-machine procedures
  audits/            immutable dated evidence and findings
.github/workflows/   PR, master and tag gates
```

## Where to look first

- Product behavior and user-visible capability: root `README.md` and the protocol tool catalog.
- Runtime ownership and request flow: [system architecture](architecture.md).
- A specific implementation area: the matching page under `modules/` and its closest `AGENTS.md`.
- Why a constraint exists: [decision index](reference/decision-index.md), then the selected ADR.
- How much to test: [testing playbook](playbooks/testing.md), then the impact planner.
- Historical failures or release evidence: `docs/audits/`; do not infer current state without rechecking.

## Engineering posture

Prefer closing boundedness, lifecycle, recovery, security and maintainability gaps over expanding the generic capability surface. New IDE integrations should be narrow, typed, reviewable and justified by IDE-native value that existing shell/filesystem tools cannot provide.
