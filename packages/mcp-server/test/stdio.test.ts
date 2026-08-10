import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test as bunTest } from "bun:test";

import {
  BRIDGE_RELEASE_VERSION,
  BRIDGE_PROTOCOL_VERSION,
  MCP_TOOL_CATALOG,
  MCP_TOOL_NAMES,
  REGISTRY_DIRECTORY_ENV,
} from "@vscode-agent-bridge/protocol";

let temporaryRegistry: string;

beforeEach(async () => {
  temporaryRegistry = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-mcp-test-"));
});

afterEach(async () => {
  await rm(temporaryRegistry, { recursive: true, force: true });
});

describe("STDIO MCP server", () => {
  bunTest("advertises bounded read and experiment tools", async () => {
    const client = new Client(
      { name: "vscode-agent-bridge-test", version: BRIDGE_RELEASE_VERSION },
      { capabilities: {} },
    );
    const compiledExecutable = process.env.VSCODE_AGENT_BRIDGE_TEST_EXE;
    const transport = new StdioClientTransport({
      command: compiledExecutable ?? "bun",
      args: compiledExecutable ? [] : ["run", "src/index.ts"],
      ...(compiledExecutable ? {} : { cwd: path.resolve(import.meta.dir, "..") }),
      env: {
        ...getDefaultEnvironment(),
        [REGISTRY_DIRECTORY_ENV]: temporaryRegistry,
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      for (const catalogEntry of MCP_TOOL_CATALOG) {
        expect(tools.tools.find((tool) => tool.name === catalogEntry.name)?.annotations).toEqual(
          catalogEntry.annotations,
        );
      }

      const capabilities = await client.callTool({
        name: "vscode_get_bridge_capabilities",
        arguments: {},
      });
      expect(capabilities.isError).not.toBe(true);
      expect(capabilities.structuredContent).toMatchObject({
        toolCount: MCP_TOOL_NAMES.length,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      });

      const result = await client.callTool({
        name: "vscode_list_instances",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ instances: [] });

      const missingInstance = await client.callTool({
        name: "vscode_get_editor_context",
        arguments: {},
      });
      expect(missingInstance.isError).toBe(true);
      expect(JSON.stringify(missingInstance.content)).toContain("NO_VSCODE_INSTANCE");

      for (const name of [
        "vscode_read_document",
        "vscode_get_diagnostics",
        "vscode_get_document_symbols",
      ]) {
        const missing = await client.callTool({ name, arguments: {} });
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("NO_VSCODE_INSTANCE");
      }
    } finally {
      await client.close();
    }
  });
});
