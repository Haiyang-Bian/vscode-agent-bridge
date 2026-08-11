# Protocol package guidance

Read the [protocol module guide](../../docs/agent-handbook/modules/protocol.md) before changing this package, plus the relevant ADR from the linked decision index.

- This package owns shared wire schemas, protocol constants, stable error codes, RPC framing, discovery contracts and the authoritative MCP tool catalog. It must not become a runtime service or import VS Code APIs.
- Keep inputs and outputs bounded and explicit. Do not expose credentials, IPC endpoints, raw stack traces or unbounded editor/workspace data.
- Treat schema, tool annotation, catalog, error-code and protocol-version changes as compatibility work. Evaluate handshake/version impact and update the nearest contract tests.
- Keep both runtime layers aligned. A contract change is incomplete until MCP and extension consumers compile and the impact registry still selects the protocol gate.
- Begin validation with the impact plan. Protocol production changes normally require the classifier-selected full gate and full E2E; do not manually weaken it.
