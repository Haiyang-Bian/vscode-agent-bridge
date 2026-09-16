# ADR 0006: Content-addressed local experiment storage

- Status: Accepted
- Date: 2026-08-09
- Superseded by ADR 0023 for release 0.14.0 and later.

## Decision

- Store versioned session manifests and immutable event files beneath extension global storage.
- Store gzip-compressed UTF-8 document snapshots by SHA-256 and deduplicate them across sessions.
- Use temporary files plus atomic rename for mutable metadata.
- Lease a session to one extension instance, with a five-second heartbeat and a thirty-second stale
  threshold.
- Default retention to thirty days or 500 MB, while never automatically deleting active, corrupt,
  or pinned sessions.
- Refuse binary and oversized snapshots and mark coverage partial instead of pretending recovery is
  complete.

The storage is a recovery journal, not a repository, synchronization service, or secret vault.
