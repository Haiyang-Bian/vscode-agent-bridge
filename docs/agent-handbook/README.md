# Agent development handbook

This handbook is the repository's progressive-disclosure map for coding agents. It is not intended to be loaded in full. Start here, select one task route, then read the closest package `AGENTS.md`, one module page and only the ADRs or playbooks needed for the change.

The scoped instruction layout follows [OpenAI's hierarchical `AGENTS.md` discovery model](https://learn.chatgpt.com/docs/agent-configuration/agents-md): repository rules load first and closer package rules take precedence, while detailed explanatory pages remain opt-in to preserve the instruction budget.

## Reading protocol

1. Read the root `AGENTS.md` and this page.
2. Inspect the current Git diff and identify the package or boundary involved.
3. Follow one row in the task router below.
4. Use exact-symbol search and nearest tests before widening to neighboring modules.
5. Read an ADR only when the task touches its decision. Read audits only for historical evidence, not as current truth.

Do not preload every ADR, release checklist, audit or source file. If the selected route does not explain an observed behavior, follow imports/callers one boundary outward and update the handbook when the gap is durable.

## Task router

| Task | Read first | Add when needed |
| --- | --- | --- |
| Understand product scope or repository shape | [Project overview](project-overview.md) | [System architecture](architecture.md) |
| Change schemas, RPC, errors, protocol version or tool catalog | [Protocol module](modules/protocol.md) | ADR 0001, 0002, 0003 and the closest contract test |
| Change MCP discovery, STDIO, RPC client or usage recording | [MCP server module](modules/mcp-server.md) | [Architecture](architecture.md), ADR 0001/0002 |
| Change extension lifecycle, policy, onboarding or composition | [VS Code extension module](modules/vscode-extension.md) | ADR 0010–0012 and the lifecycle tests |
| Change experiments, edits, resources or workspace configuration | [VS Code extension module](modules/vscode-extension.md) | ADR 0005–0007, 0010 and 0013 |
| Change Task, terminal or Debug behavior | [VS Code extension module](modules/vscode-extension.md) | ADR 0009, 0011, 0013 and [Debugging](playbooks/debugging.md) |
| Change extension discovery, Marketplace, Profile or adapters | [VS Code extension module](modules/vscode-extension.md) | ADR 0015–0017 |
| Change Git or Managed Worktree behavior | [VS Code extension module](modules/vscode-extension.md) | ADR 0008 and managed-git tests |
| Change build, test selection, E2E, packaging, CI or release | [Tooling and release](modules/tooling-and-release.md) | [Testing playbook](playbooks/testing.md) and ADR 0018 |
| Open or maintain the VS Code development environment | [VS Code workspace](playbooks/vscode-workspace.md) | [Tooling and release](modules/tooling-and-release.md) |
| Implement a feature or fix a bug | [Change workflow](playbooks/change-workflow.md) | Module page, [Debugging](playbooks/debugging.md), nearest regression test |
| Choose or diagnose validation | [Testing playbook](playbooks/testing.md) | [Authoritative testing strategy](../testing-strategy.md) |
| Create an ADR, audit, release or handbook update | [Handbook maintenance](maintenance.md) | [Decision index](reference/decision-index.md) |
| Look up a stable command | [Command reference](reference/commands.md) | Owning script and `package.json` |

## Knowledge layers

| Layer | Purpose | Authority |
| --- | --- | --- |
| Root and nested `AGENTS.md` | Automatically loaded constraints and local rules | Mandatory for Agent behavior in scope |
| Accepted ADRs | Why durable architecture/security choices exist | Architectural decision record |
| Code, manifests and tests | What the current implementation does | Current implementation truth |
| This handbook | Fast orientation, ownership and reading routes | Maintained synthesis; reconcile when stale |
| README and release docs | User-facing behavior and release intent | Product/release description |
| Acceptance and audit reports | Procedures and dated evidence | Time-bounded evidence, not current state by default |

## Handbook map

- [Project overview](project-overview.md): goals, maturity, supported environment and repository map.
- [System architecture](architecture.md): runtime flow, ownership, state and security boundaries.
- `modules/`: ownership and change routes for each workspace and repository tooling.
- `playbooks/`: feature/bug workflow, testing, diagnosis and the curated VS Code workspace.
- `reference/`: stable commands and ADR routing.
- [Maintenance](maintenance.md): update triggers and anti-staleness rules.
