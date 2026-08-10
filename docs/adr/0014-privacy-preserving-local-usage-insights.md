# ADR 0014: Privacy-preserving local usage insights

- Status: Accepted
- Release: 0.8.0

## Context

The Bridge needs evidence about which IDE capabilities Agents actually use and where bounded workflows encounter friction. Raw MCP parameters and results can contain source code, paths, terminal output, debug values, credentials, or other private workspace data. Treating call counts as personality or model learning would also overstate what local telemetry can establish.

## Decision

Each MCP process writes a separate append-only local event file. Events contain only the catalog tool name and category, start and finish time, outcome, coarse latency and message-size buckets, truncation, and a stable error code. Parameters, results, paths, hashes, source, terminal content, expressions, variables, environment variables, and credentials are never written.

Events remain on the local machine for at most 30 days and share a 20 MiB limit. The extension exposes explicit clear and aggregate export commands. It never uploads insight data. Suggestions are deterministic rules backed by displayed counts, such as repeated stale preconditions or truncation; they are not claims about Agent personality or autonomous model improvement.

## Consequences

- Multiple MCP processes do not contend for one writable file.
- Aggregate reports are useful for harness tuning without becoming a replay log.
- The data cannot reconstruct a request, result, file, command, or debug interaction.
- Clearing insight files does not affect experiment history, and experiment snapshots never contain insight events.
