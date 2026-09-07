# v0.12 master integration verification

- Date: 2026-09-07
- Status: `completed_with_findings`
- Scope: validate and integrate the remote development branch before Phase 1 HTTP implementation.
- Environment: Windows x64, repository-pinned Bun 1.3.11, VS Code 1.136.1; isolated worktree, workspace, registry and VS Code profiles.

## Revisions and method

Original `master` was `875812fd0f23d800cf4449fbb627ed279963a028`. The remote `codex/v0.12-security-autonomy` branch at `a8652642f3b1bc2e6988ae2e2b3162c749cda988` contained seven needed commits and was fast-forwardable. The pending lifecycle investigation and report index were protected separately, then restored on `codex/shared-http-daemon` without deleting either old or new report rows.

Validation found two E2E environment defects. Commit `cea212ad8ee6fdd530ac4e1ea229fd96625a7636` made PowerShell shell integration explicit inside the isolated child terminal. Commit `2b7e366319a3fda04ec6361ce2caff25c9bbaca3` canonicalized temporary fixture roots because Windows CI exposed TEMP through an 8.3 alias. No production path guard or PowerShell user profile was relaxed.

`master` was advanced normally and pushed without force. Its successful CI run is [34095891042](https://github.com/Haiyang-Bian/vscode-agent-bridge/actions/runs/34095891042). The old branch was deleted only after ancestry/worktree checks, using a lease against its reviewed tip. The temporary validation worktree and branch were then removed. Feature development remains separate from `master`.

## Results

| Boundary | Result | Evidence |
| --- | --- | --- |
| Fixed Bun environment | Pass | Portable Bun 1.3.11; frozen dependency install |
| Full check after local terminal fix | Pass | 151 tests, all typechecks and builds |
| Initial usage-insight timeout | Diagnosed | 40-record test timed out while simultaneous feasibility probes saturated the host; isolated test passed in 125 ms and normal-load full gate passed; timeout unchanged |
| Source E2E and artifact gate at `cea212a` | Pass | Two full isolated E2E runs; EXE, VSIX, checksums, test bundle and installed-VSIX E2E |
| Initial master CI | Failed, fixed | Run 34095085574 exposed the Windows TEMP alias difference |
| Final baseline full check | Pass | 152 tests including the canonical-parent regression |
| Final baseline E2E | Pass | Two independent complete source E2E runs |
| Final master CI at `2b7e366` | Pass | Full check, repeat E2E, packaging, checksums, bundle and artifact job all successful |
| Second Windows identity ACL rejection | Not executed | Historical v0.12 acceptance boundary remains explicit |

## Findings

1. **Resolved, test environment:** stock PowerShell 5 and a clean PowerShell profile did not establish the required shell integration. The fixture now uses PowerShell 7 with the exact installed VS Code integration script and child-only execution policy.
2. **Resolved, test environment:** the CI temporary-directory alias differed from Git/VS Code canonical paths. Canonicalization belongs at fixture creation; security comparisons were preserved.
3. **Open acceptance boundary:** current-user permission inspection does not establish rejection under a second Windows identity. No claim is made that this historical item passed.

## Artifacts and side effects

Baseline evidence is retained under ignored `artifacts/phase1-baseline-evidence/`. The `cea212a` local production artifacts had these SHA-256 values (the later fixture-only fix did not change production sources):

- EXE: `6d472a953c5e7c2897144ad6c95e474ee242129ee09245113eace0369641dff2`
- VSIX: `681a84e841ed9d748bd5ab9552392a27ff1484191dff78723a111221a339abd8`
- Test bundle: `7873d7938e99628c87d9377ec4ffb9ab9d9770a87ce14e7cbca4c3f39189fbb9`

No Marketplace publication, release tag, formal Codex configuration change or bulk process termination occurred during baseline integration. The next gate is Phase 1 HTTP/daemon/installer acceptance on the feature branch.
