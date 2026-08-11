# Tiered test gates audit

- Date: 2026-08-11
- Status: `completed_with_findings`
- Scope: affected-test planning, domain gates, selectable Extension Host scenarios, hermetic profiles, CI routing, packaged VSIX validation and agent governance
- Environment: Windows x64, Bun 1.3.11, VS Code 1.132.0, release 0.11.0, protocol v10, 60 bounded IDE tools

## Method and preconditions

The implementation was validated on a dedicated branch from a clean `master`. The impact registry remained the shared source for local commands, CI outputs and E2E scenario selection. No MCP schema, error code, tool definition or extension user behavior was intentionally changed.

Validation proceeded from the smallest deterministic checks outward: classifier fixtures, selected scenario smoke runs, the classifier-mandated complete non-E2E gate, two independent full Extension Host runs and a packaged VSIX smoke. A second complete non-E2E gate was run only after the Git rename classifier changed; the already-passing E2E and artifact gates were not repeated for documentation-only edits.

## Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Impact classifier and runner tests | Pass | 14/14 tests, including docs-only, domain selection, protocol and cross-runtime escalation, manual expansion, unknown paths, packaging, production-source coverage, staged/unstaged/untracked changes, rename/delete, explicit base/head and unavailable-base fail-closed behavior |
| Core-language smoke | Pass | Selected scenario completed in 6.2 seconds overall; the Extension Host test took about 1 second and did not receive lifecycle delays |
| Debug selected scenario | Pass | Completed in 5.8 seconds overall; the Extension Host test took about 2.3 seconds without running Task or resource target flows |
| Complete non-E2E gate | Pass | Final run: 120 tests, 0 failures, 880 assertions; all three workspaces typechecked and built in 10.3 seconds |
| Full E2E repeat | Pass | Two independent runs passed 2/2 tests each in about 58 and 57 seconds; total 122 seconds; both Extension Host processes exited with code 0 |
| Packaging and checksums | Pass | VSIX packaging completed in 10.7 seconds; executable, VSIX and Windows test bundle checksums were generated |
| Packaged artifact smoke | Pass after repair | Release metadata, packaged VSIX installation, full packaged Extension Host E2E and MCP STDIO smoke passed in 66.2 seconds using the existing VS Code cache |
| Current-run cleanup | Pass | Each runner asserted removal of its own workspace, registry, user-data, extensions and managed-worktree root after completion |

Artifact SHA-256 values:

| Artifact | SHA-256 |
| --- | --- |
| MCP executable | `cfc5fd0aaedbf94eb36911e48f40ba02756025345af83a2e52151abdccc9c4c3` |
| VSIX | `d106353cae3711659838c36322e8f140e9e395569df773ac62a7aac25fb577fd` |
| Windows x64 test bundle | `76d54bd1a70c835738401b6f86bfad92b675c01041a121666386e5404c1bad16` |

## Findings

### 1. Packaged runner initially installed into the wrong extension directory

- Severity: high for test validity; resolved in this change
- Evidence: the first packaged smoke installed the VSIX into the default extension cache while launching VS Code with a new isolated extensions directory. The host therefore could not observe the installed package.
- Impact: an apparently isolated packaged test could fail before exercising the package, and its installation side effect escaped the per-run profile.
- Resolution: the packaged runner now uses the official VS Code command runner to install the VSIX directly into the same temporary user-data and extensions directories passed to the test host. The final artifact smoke passed.
- Recommendation: keep packaged and development runners on the shared environment helper and retain an end-to-end assertion that the package is visible inside the temporary profile.

### 2. Rename detection needed both old and new paths

- Severity: high for selector correctness; resolved in this change
- Evidence: a name-only Git diff can report only the destination of a detected rename. A production file renamed outside its registered area could then hide the deleted source path from impact classification.
- Impact: affected or mandatory gates could be under-selected.
- Resolution: change collection disables rename collapsing, so a rename is classified as deletion plus addition. A temporary Git fixture now verifies rename and delete behavior.
- Recommendation: retain this fixture whenever Git diff collection changes.

### 3. Historical temporary roots predate the hermetic runner

- Severity: low; informational
- Evidence: a machine-wide inspection found 27 `vscode-agent-bridge-e2e-*` directories created on 2026-08-09 or 2026-08-10. None matched roots created by the audited runs.
- Impact: old test data consumes local temporary storage and makes an unscoped machine-wide "zero leftovers" assertion invalid.
- Resolution: the new runner asserts deletion of the exact root it creates. Historical directories were preserved because their deletion was outside this implementation's authorized scope.
- Recommendation: remove the historical directories only through a separately reviewed cleanup action; keep current-run cleanup scoped by the generated root identifier.

## Side effects and artifacts

- The test runs created isolated temporary Git repositories, workspaces, registries, user-data directories, extension directories and managed worktrees; current-run roots were removed in `finally` cleanup.
- The packaged smoke reused the repository-local VS Code 1.132.0 cache and did not download another runtime.
- Release artifacts and checksum files were generated under the ignored artifact area.
- Extension settings modified during E2E were restored by scenario-level `try/finally` blocks.
- No historical temporary directories, user projects or external configuration were deleted.

## Closure criteria

All implementation gates required by the classifier passed. The impact registry covers every current production TypeScript source, unknown production paths fail closed, scenario and repeat markers were validated, current-run profiles cleaned successfully and packaged VSIX behavior remained intact.

The next mandatory broad validation is the normal Pull Request gate. Ordinary follow-up development should start with the affected planner and must not repeat the full gates unless the classifier, environment or changed files require them.
