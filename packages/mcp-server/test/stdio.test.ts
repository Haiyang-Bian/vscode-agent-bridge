import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { REGISTRY_DIRECTORY_ENV } from "@vscode-agent-bridge/protocol";

let temporaryRegistry: string;

beforeEach(async () => {
  temporaryRegistry = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-mcp-test-"));
});

afterEach(async () => {
  await rm(temporaryRegistry, { recursive: true, force: true });
});

describe("STDIO MCP server", () => {
  test("advertises the initial tools and lists an empty registry", async () => {
    const client = new Client(
      { name: "vscode-agent-bridge-test", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts"],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...getDefaultEnvironment(),
        [REGISTRY_DIRECTORY_ENV]: temporaryRegistry,
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "vscode_get_editor_context",
        "vscode_list_instances",
      ]);

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
    } finally {
      await client.close();
    }
  });
});
