import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, test as bunTest } from "bun:test";

import { BRIDGE_RELEASE_VERSION, MCP_TOOL_NAMES, REGISTRY_DIRECTORY_ENV } from "@vscode-agent-bridge/protocol";

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
      for (const tool of tools.tools.filter((item) =>
        ![
          "vscode_prepare_text_edits",
          "vscode_prepare_rename",
          "vscode_list_code_actions",
          "vscode_apply_change_set",
          "vscode_apply_code_action",
          "vscode_format_document",
          "vscode_record_experiment_evidence",
          "vscode_save_document",
          "vscode_start_experiment",
          "vscode_rename_experiment",
          "vscode_create_experiment_checkpoint",
          "vscode_prepare_resource_changes",
          "vscode_update_workspace_configuration",
          "vscode_run_task",
          "vscode_terminate_task",
          "vscode_start_debug_session",
          "vscode_control_debug_session",
          "vscode_update_breakpoints",
          "vscode_evaluate_debug_expression",
          "vscode_set_debug_variable",
        ].includes(item.name),
      )) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      for (const name of [
        "vscode_prepare_text_edits",
        "vscode_prepare_rename",
        "vscode_prepare_resource_changes",
        "vscode_list_code_actions",
      ]) {
        expect(tools.tools.find((tool) => tool.name === name)?.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        });
      }
      for (const name of [
        "vscode_apply_code_action",
        "vscode_format_document",
        "vscode_record_experiment_evidence",
        "vscode_save_document",
        "vscode_start_experiment",
        "vscode_rename_experiment",
        "vscode_create_experiment_checkpoint",
        "vscode_update_workspace_configuration",
        "vscode_update_breakpoints",
      ]) {
        expect(tools.tools.find((tool) => tool.name === name)?.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        });
      }
      expect(tools.tools.find((tool) => tool.name === "vscode_apply_change_set")?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      for (const name of [
        "vscode_run_task",
        "vscode_terminate_task",
        "vscode_start_debug_session",
        "vscode_control_debug_session",
        "vscode_evaluate_debug_expression",
        "vscode_set_debug_variable",
      ]) {
        expect(tools.tools.find((tool) => tool.name === name)?.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        });
      }

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
