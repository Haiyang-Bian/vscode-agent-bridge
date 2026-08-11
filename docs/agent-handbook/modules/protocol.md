# Protocol module

## Purpose

`packages/protocol` is the shared contract library compiled into both runtime layers. It keeps transport and tool behavior aligned without becoming a service.

## Ownership map

| Area | Primary files |
| --- | --- |
| Protocol/release constants | `src/constants.ts` |
| Stable errors and public failure mapping | `src/errors.ts` |
| JSON-RPC framing and envelopes | `src/rpc.ts` |
| Instance discovery contracts | `src/registry.ts`, descriptor/public-instance schemas in `src/schemas.ts` |
| General IDE/language schemas | `src/ide.ts`, `src/schemas.ts`, `src/workspace.ts` |
| Experiment/change contracts | `src/experiments.ts` |
| Task/Debug/workflow contracts | `src/workflows.ts`, `src/terminals.ts` (prepared/persisted definitions, fingerprints and provenance) |
| Extension reflection/orchestration/adapters | `src/extension-awareness.ts`, `src/extension-orchestration.ts`, `src/extension-integrations.ts` |
| Usage insights | `src/insights.ts` |
| Authoritative MCP names and metadata | `src/tool-catalog.ts` |
| Public exports | `src/index.ts` |

## Change rules

- Add a schema where the concept is owned; do not accumulate unrelated shapes in a generic file.
- Define strict bounds, defaults and refinements at the contract edge. Runtime code should not need to guess whether an input is safe.
- Add stable error codes deliberately and map expected failures without exposing raw internal exceptions.
- Keep tool names, categories, annotations, side effects, sensitivity and recovery descriptions in the catalog source of truth.
- Evaluate whether wire compatibility requires a protocol-version change. Update both runtime consumers and version/catalog tests in the same change.
- Do not import `vscode`, start listeners, read the workspace or persist state here.

## Evidence route

Start with the nearest contract test under `packages/protocol/test/`. Then inspect the MCP registration/use site and the extension request handler that consume the contract. Avoid reading both runtimes wholesale.

Protocol production changes are high risk in the impact registry. Begin with `bun run test:plan` and accept the full gate/E2E selection rather than substituting a smaller manual command.

## Decisions

Read ADR 0001 for runtime separation, ADR 0002 for the local security boundary, ADR 0003 for tool contracts, and the capability-specific ADR from the [decision index](../reference/decision-index.md).
