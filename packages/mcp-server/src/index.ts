#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  EditorContextSchema,
  PublicInstanceSchema,
  asBridgeError,
  type BridgeError,
} from "@vscode-agent-bridge/protocol";

import { discoverInstances, selectInstance, toPublicInstance } from "./instances.js";
import { requestEditorContext } from "./rpc-client.js";

const ListInstancesInputSchema = z.object({}).strict();
const ListInstancesOutputSchema = z
  .object({
    instances: z.array(PublicInstanceSchema),
  })
  .strict();
const GetEditorContextInputSchema = z
  .object({
    instanceId: z.string().uuid().optional(),
  })
  .strict();

const server = new McpServer(
  {
    name: "vscode-agent-bridge",
    version: "0.1.0",
  },
  {
    instructions:
      "Use this server only for IDE-native VS Code state such as active editors, unsaved buffers, diagnostics, language services, navigation, and protected editor actions. Continue to use filesystem and shell tools for ordinary file operations. Call vscode_list_instances before targeting a window when more than one VS Code instance may be open. Never infer that a registered instance is connected if a tool returns INSTANCE_UNAVAILABLE.",
  },
);

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

server.registerTool(
  "vscode_list_instances",
  {
    title: "List VS Code instances",
    description:
      "List locally registered VS Code windows. Credentials and IPC endpoints are never returned.",
    inputSchema: ListInstancesInputSchema,
    outputSchema: ListInstancesOutputSchema,
    annotations: readOnlyAnnotations,
  },
  async () => {
    try {
      const instances = (await discoverInstances()).map(toPublicInstance);
      const result = { instances };
      return {
        content: [
          {
            type: "text",
            text:
              instances.length === 0
                ? "No registered VS Code instances were found."
                : `Found ${instances.length} registered VS Code instance(s).`,
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_get_editor_context",
  {
    title: "Get VS Code editor context",
    description:
      "Return active and visible editors, selections, dirty state, document versions, workspace folders, and trust state for one VS Code window.",
    inputSchema: GetEditorContextInputSchema,
    outputSchema: EditorContextSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId }) => {
    try {
      const descriptor = selectInstance(await discoverInstances(), instanceId);
      const context = await requestEditorContext(descriptor);
      return {
        content: [
          {
            type: "text",
            text: context.activeEditor
              ? `Active editor: ${context.activeEditor.uri}`
              : "The selected VS Code window has no active text editor.",
          },
        ],
        structuredContent: context,
      };
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

function toolError(error: BridgeError): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  console.error(`[${error.code}] ${error.message}`);
  return {
    content: [
      {
        type: "text",
        text: `${error.code}: ${error.message}`,
      },
    ],
    isError: true,
  };
}

await server.connect(new StdioServerTransport());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
