#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer(
  {
    name: "vscode-agent-bridge",
    version: "0.1.0",
  },
  {
    instructions:
      "Use this server only for IDE-native VS Code context and actions. Continue to use filesystem and shell tools for ordinary file operations. The bridge currently exposes no tools until a VS Code instance is connected.",
  },
);

await server.connect(new StdioServerTransport());
