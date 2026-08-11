# Debugging playbook

## Locate the failing layer

Use this order before changing code:

1. MCP client invocation and explicit instance selection.
2. Descriptor discovery and live probing.
3. Local IPC authentication, initialization and protocol version.
4. `BridgeHost` lifecycle and dispatch.
5. Request handler schema/routing/error mapping.
6. Manager/service state transition.
7. VS Code API/provider/Task/Debug/Git boundary.
8. Packaging, cache, profile or host-process cleanup.

A symptom at the MCP surface can originate several layers below. Preserve stable public errors while finding the internal owner.

## Minimal evidence ladder

- Reproduce with the narrowest existing unit/contract test or one selected E2E scenario.
- Read the exact handler and manager involved, then their direct tests.
- Check lifecycle state, workspace trust, instance/session/root routing and stale preconditions.
- Distinguish development-extension runs from packaged VSIX runs and default profiles from isolated profiles.
- For Git fixtures, check branch, worktree, dirty state, hooks and exact path containment before blaming promotion logic.
- For terminal/Task/Debug, distinguish observed IDE lifecycle from external process effects that the bridge cannot recover.

Do not log or paste authentication tokens, descriptor endpoints, source snapshots, terminal content, expressions, variables, environment values or raw Codex configuration into reports.

## Common state hazards

- Stale descriptor after a crashed or disabled extension.
- Multiple live windows without explicit instance selection.
- Protocol mismatch between installed MCP executable and extension.
- Reused user-data/extensions directories hiding setup defects.
- Global VS Code settings not restored after a failed test.
- Experiment lease/session mismatch or stale document/hash/fingerprint.
- Onboarding/policy state from an earlier profile.
- Packaged VSIX installed into a different extensions directory from the launched host.

## After a fix

Add the nearest deterministic regression, rerun only that failure, then follow the impact planner. If the failure crossed the real Extension Host or packaged boundary, run the selected scenario/artifact gate once and verify cleanup in the same result.

When the user requested diagnosis only, stop after evidence-backed cause and scope. Do not silently implement a repair.
