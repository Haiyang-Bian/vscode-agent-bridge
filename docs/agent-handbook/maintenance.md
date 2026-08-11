# Handbook maintenance

## Authority and purpose

The handbook is a navigation and synthesis layer. It must make current ownership easier to find without competing with code, manifests, tests or Accepted ADRs.

When sources disagree:

1. verify the live implementation and tests;
2. check whether an Accepted ADR still governs the design;
3. identify whether code, handbook or ADR migration is incomplete;
4. reconcile the mismatch explicitly rather than silently editing the most convenient document.

## Required update triggers

| Change | Handbook/governance update |
| --- | --- |
| New workspace/package or runtime layer | Project overview, architecture, task router and a local `AGENTS.md`; usually an ADR |
| New production module or ownership move | Matching module map and test-impact registry |
| New MCP tool/schema/error/protocol version | Protocol module if ownership changed, closest contract tests and relevant ADR |
| New persistent/open-world/user-confirmed behavior | Architecture security/side-effect section and an ADR |
| New test domain, E2E scenario or gate command | Root rules, testing playbook, command reference, testing strategy and registry tests |
| New packaging/install boundary | Tooling module, command reference, artifact classification and acceptance docs |
| Changed `.code-workspace`, Tasks, launch or shared VS Code settings | VS Code workspace playbook, workspace checker and impact classification |
| Changed release version or supported platform | Source manifests first, then project overview/README/release docs |
| New recurring diagnosis pattern | Debugging playbook, without copying sensitive logs or one-off output |

## Writing rules

- Route before explaining: every durable topic should be reachable from `README.md` in one or two links.
- Keep root/nested `AGENTS.md` concise because Codex combines them under an instruction-size budget.
- Put mandatory behavior in the scoped `AGENTS.md`; put explanation and examples here.
- Prefer stable paths, owners and invariants over line numbers or large source inventories.
- Mark drift-sensitive snapshots with a reconciliation date and an authoritative source.
- Link to an ADR rather than duplicating its full rationale.
- Treat audit reports as immutable dated evidence. Never turn one into a living status page.
- Do not include tokens, IPC endpoints, raw Codex configuration, source snapshots, terminal output or machine-specific absolute paths.

## Review checklist

Before closing a handbook change:

1. Run `bun scripts/check-agent-handbook.ts` to validate required pages, links, machine-specific paths and instruction-chain size.
2. Run `bun scripts/check-vscode-workspace.ts` when shared VS Code configuration changed.
3. Confirm the ownership map agrees with imports/composition and nearest tests.
4. Check that a new production path is classified by `scripts/lib/test-impact.ts`.
5. Run `bun run test:plan`; documentation-only changes should not trigger code/E2E gates.
6. Run `git diff --check` and inspect the final scope.

Use a focused commit for handbook governance. A standalone handbook audit may create a dated report; ordinary handbook creation or maintenance does not require an audit report.
