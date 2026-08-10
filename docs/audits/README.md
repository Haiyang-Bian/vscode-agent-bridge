# Test and audit reports

This directory is the durable record for executed manual tests, exploratory tests, integration checks, self-bootstrap exercises and focused audits. Future test summaries must be written here before the work is closed out, even when no implementation change or Git commit follows.

Formal release procedures remain under `docs/acceptance/`. When one of those procedures is executed, keep the procedure stable and place the dated execution summary here, with a link back to the relevant acceptance document.

## Filing convention

- Name reports `YYYY-MM-DD-<release-or-scope>.md` using a short, stable scope.
- Create a new dated report for a materially different run. Do not rewrite an older report to make a later run appear to have passed.
- Use `completed`, `completed_with_findings`, `blocked` or `failed` as the overall status.
- Separate verified behavior from inference, untested paths and recommendations.
- Record exact stable error codes and bounded timing evidence when they matter.
- State every material side effect, including settings changes, checkpoints, Git operations and files touched.
- Replace usernames and machine-specific roots with `<HOME>`, `<REPOSITORY>` and `<MANAGED_WORKTREE>`. Never record tokens, IPC endpoints, terminal output, source snapshots or raw Codex configuration.

## Required report sections

Each report should include:

1. date, status, scope and environment;
2. the test method and preconditions;
3. a result matrix distinguishing pass, fail and untested paths;
4. numbered findings with severity, evidence, impact and recommendation;
5. side effects and artifacts created by the run;
6. explicit closure criteria and the next validation gate.

## Report index

| Date | Scope | Status | Report |
| --- | --- | --- | --- |
| 2026-08-10 | v0.6.0 self-bootstrap reload | `completed_with_findings` | [v0.6.0 self-bootstrap reload audit](2026-08-10-v0.6.0-self-bootstrap-reload.md) |
| 2026-08-10 | v0.6.1 automated remediation | `completed_with_findings` | [v0.6.1 self-bootstrap remediation](2026-08-10-v0.6.1-self-bootstrap-remediation.md) |
| 2026-08-10 | v0.7.0 IDE workflow self-bootstrap | `completed` | [v0.7.0 IDE workflow self-bootstrap audit](2026-08-10-v0.7.0-ide-workflow-self-bootstrap.md) |
| 2026-08-10 | v0.8.0 Bridge Hub release candidate | `completed_with_findings` | [v0.8.0 Bridge Hub release audit](2026-08-10-v0.8.0-bridge-hub-release.md) |
| 2026-08-10 | v0.9.0 extension awareness release candidate | `completed_with_findings` | [v0.9.0 extension awareness release audit](2026-08-10-v0.9.0-extension-awareness-release.md) |
| 2026-08-10 | v0.10.0 extension orchestration release candidate | `completed_with_findings` | [v0.10.0 extension orchestration release audit](2026-08-10-v0.10.0-extension-orchestration-release.md) |
