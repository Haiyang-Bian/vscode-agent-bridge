# ADR 0015: Extension awareness and observable IDE signals

- Status: accepted
- Date: 2026-08-10

## Context

VS Code derives much of its language and workflow intelligence from extensions. The Bridge already consumes standard language providers, diagnostics, Tasks and Debug APIs, but an Agent could not tell which extensions supplied those capabilities or inspect the user-visible Problems, Output and Debug Console signals used to diagnose extension startup and runtime failures.

VS Code does not expose a complete stable API for enumerating or reading every Output Channel, nor a stable API for private Profile metadata. Activating arbitrary extensions or reading their exports would also widen the trust boundary beyond an IDE-native observation layer.

## Decision

Protocol v8 exposes installed-extension metadata and manifest-declared contributions through `vscode.extensions.all`. Listing and inspection never call `activate()`, read extension exports or execute contributed commands. Current Profile information reports unavailable fields as `null` rather than reading private VS Code storage.

Problems changes are represented by a 15-minute, 2,000-event in-memory summary ring. Diagnostic bodies are not persisted by this observer. Output discovery is intentionally coverage-aware: it combines currently opened Output documents, Bridge-captured Terminal/Task/Debug streams, diagnostic sources and manifest-declared capabilities. Only an already opened Output document may be read; the Bridge never switches channels or reads private log directories.

Debug Console text is captured from DAP `output` events after Bridge activation. Only `stdout`, `stderr`, `console` and `important` categories are retained. ANSI and control sequences are sanitized, source locations are workspace-relative, and buffers are limited to 1 MiB per session and 8 MiB per window with 15-minute ended-session retention. Telemetry, raw DAP messages, evaluate expressions and variable values are discarded.

## Consequences

- Extension state and contributions are useful metadata, not proof that an extension is healthy or safe.
- Output coverage is explicitly `metadataOnly`, `visible`, `captured` or `adapter`; unavailable history is never presented as complete.
- Calls cannot wake inactive extensions or bypass Publisher Trust.
- Complete Output Channel enumeration and pre-activation Debug Console history remain unavailable until VS Code provides stable public APIs.
- Marketplace installation, current-Profile configuration and reviewed extension adapters remain separate later protocols with their own side-effect boundaries.
