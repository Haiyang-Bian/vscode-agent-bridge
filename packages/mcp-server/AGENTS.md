# MCP server guidance

Read the [MCP server module guide](../../docs/agent-handbook/modules/mcp-server.md) before changing this package.

- The MCP server translates bounded MCP requests into authenticated local RPC calls. It does not own VS Code behavior and must not manipulate a workspace directly.
- Derive names, schemas, annotations and classified behavior from `packages/protocol`; do not create a second tool catalog.
- Preserve explicit instance selection, protocol negotiation, timeout/cancellation behavior and redaction of descriptor credentials and IPC endpoints.
- Keep STDIO clean: protocol messages belong on STDIO; diagnostics must not corrupt MCP framing.
- Usage insights retain only privacy-preserving aggregates and stable metadata. Never record parameters, results, paths, source, terminal content, expressions, variables or credentials.
- Start with `bun run test:plan`; use the `mcp-runtime` domain for focused investigation and accept any automatic escalation.
