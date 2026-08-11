# ADR 0021: Canonical paths, document grants and Windows local identity

- Status: Accepted
- Date: 2026-08-11
- Release: 0.12.0

## Context

Lexical `path.resolve` and `path.relative` checks do not establish a filesystem boundary when a
workspace contains a junction, reparse point or symlink. The same problem affects a missing target
whose nearest existing ancestor redirects outside the workspace. Language tools also accepted an
arbitrary URI and could open a provider-backed document without a relationship to the visible
workspace.

On Windows, POSIX `mode` options do not establish an owner-only DACL. Instance descriptors contain
the bearer token used to authenticate local Bridge requests, so their effective ACL is part of the
product security boundary.

## Decision

- One canonical path service owns local workspace containment for reads, edits, resource changes,
  configuration, experiments, breakpoints and Agent Task working directories.
- Workspace roots are resolved with the native realpath implementation. Existing path components
  are inspected without following their final link identity; symlink, junction and reparse parents
  are rejected. A missing target is validated from its nearest existing ancestor. The boundary is
  revalidated immediately before mutation.
- Windows comparisons use normalized drive and case semantics. UNC, cross-drive, case-folding,
  missing-target and reparse-point behavior are contractually tested.
- Local document access is allowed when the document is already open in the selected VS Code
  instance or its canonical file path is contained by a trusted workspace root.
- Definition and reference providers may return an external file or virtual URI. The extension may
  issue a random, exact-URI, instance-bound, workspace-derived read grant for that result. Grants
  are memory-only, expire after ten minutes and can authorize bounded read and language follow-up
  operations for the exact URI only.
- An arbitrary caller-supplied external or provider-backed URI is rejected. Already-open virtual
  documents and exact provider-derived grants remain usable.
- Provider-backed symbol, hover, definition and reference tools are annotated as read-only but
  open-world and non-idempotent. Plain document reads remain closed-world after scope validation.
- On Windows the extension obtains the current SID with a fixed `whoami.exe` argument vector and
  applies a non-inherited ACL with fixed `icacls.exe` argument vectors. Only the current SID and
  SYSTEM receive access to the registry directories and descriptor files.
- Descriptor publication uses create, write, fsync, close, ACL hardening, atomic rename and a
  post-rename ACL check. A hardening failure prevents publication of the descriptor and token.
- The named pipe continues to require the random bearer token. Release acceptance verifies that a
  separate restricted identity cannot read the descriptor and cannot authenticate to the pipe.

## Consequences

- Workspace containment is based on the resolved filesystem rather than spelling alone. The
  project still does not claim protection from malicious same-user races after the final check.
- Agents can follow language-service results into external libraries without receiving arbitrary
  local-file or provider access.
- Windows is the primary distribution target and therefore treats ACL setup failure as a release
  and publication failure rather than silently falling back to POSIX permission hints.

## Relationship to earlier decisions

This decision strengthens ADR 0002, ADR 0007, ADR 0011 and ADR 0013. Their authentication,
precondition and recovery rules remain in force; lexical containment and best-effort Windows mode
bits are no longer sufficient for the v0.12 boundary.
