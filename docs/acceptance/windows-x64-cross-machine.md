# Windows x64 cross-machine acceptance

Run this against the checksum-protected `0.2.0` test bundle before Marketplace publication. Use a different Windows x64 computer with a clean VS Code profile, no Bun or Node.js, and no clone of this repository.

## Human setup

1. Verify the transferred bundle ZIP against its adjacent `.sha256` file, extract it, and verify the inner `SHA256SUMS.txt` with `Get-FileHash`.
2. In a clean VS Code profile, choose **Extensions > ... > Install from VSIX...** and install the bundled `vscode-agent-bridge-0.2.0-win32-x64.vsix`. Confirm the installed ID is `AliceLin.vscode-agent-bridge`.
3. Open an ordinary project unrelated to VS Code Agent Bridge.
4. Run **VS Code Agent Bridge: Configure Codex**, confirm, and restart Codex.
5. Start a new Codex task on that computer and paste the prompt below.

## Acceptance prompt for Codex

> Perform the VS Code Agent Bridge 0.2.0 unpublished Windows x64 candidate acceptance. Do not install Bun or Node.js and do not clone the bridge source repository. Work only in a newly created temporary TypeScript workspace and delete it when evidence collection is complete.
>
> 1. Record Windows architecture/version, VS Code version, extension version, and SHA-256 of `%LOCALAPPDATA%/VSCodeAgentBridge/versions/0.2.0/vscode-agent-bridge-mcp.exe`. Redact the username and replace all home/project path prefixes in the final report with `<HOME>` and `<WORKSPACE>`.
> 2. Create a small TypeScript file containing one exported function, two calls, and an intentional type error. Open it in VS Code, append the unique marker `UNSAVED_BRIDGE_CROSS_MACHINE_020` without saving, and independently confirm the disk file lacks the marker.
> 3. Use all eight `vscode_*` tools. Confirm instance discovery identifies this external workspace; editor context is local; document read sees the unsaved marker and dirty versioned buffer; diagnostics contain the intentional TypeScript error; symbols contain the exported function; definition, references and hover resolve at an explicit zero-based position.
> 4. Open a second VS Code window. Confirm a tool call without `instanceId` returns `AMBIGUOUS_INSTANCE`; then pass each returned ID and confirm correct routing. Close the second window, wait briefly, and confirm it no longer appears in `vscode_list_instances`.
> 5. Run **VS Code Agent Bridge: Run Doctor** and record only its status fields. Add an unrelated harmless setting outside the managed Codex block, run **Remove Codex Configuration**, and confirm only the marked bridge block is removed. Restore the bridge by running **Configure Codex** again.
> 6. Produce `vscode-agent-bridge-0.2.0-acceptance.md` and a matching JSON report. Include one pass/fail item per tool and per lifecycle check, executable SHA-256, and a final `overallStatus`. Do not include tokens, IPC endpoints, usernames, raw home paths, full Codex configuration, or unrelated file contents. If any item fails, preserve redacted evidence, do not publish the candidate, and recommend a `0.2.1` fix.

## Release decision

Only a report with `overallStatus: "passed"` permits adding the label “Windows x64 cross-machine verified” to release notes or enabling Marketplace publication. A failure keeps the candidate unpublished and creates a new patch candidate.
