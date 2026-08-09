#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  BRIDGE_METHODS,
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  DiagnosticsInputSchema,
  DiagnosticsParamsSchema,
  DiagnosticsResultSchema,
  DocumentSnapshotSchema,
  DocumentSymbolsInputSchema,
  DocumentSymbolsParamsSchema,
  DocumentSymbolsResultSchema,
  EditorContextSchema,
  HoverInputSchema,
  HoverParamsSchema,
  HoverResultSchema,
  LocationsResultSchema,
  PositionedDocumentInputSchema,
  PositionedDocumentParamsSchema,
  PublicInstanceSchema,
  ReadDocumentInputSchema,
  ReadDocumentParamsSchema,
  asBridgeError,
  type BridgeError,
  type InstanceDescriptor,
} from "@vscode-agent-bridge/protocol";

import { discoverLiveInstances, selectInstance, toPublicInstance } from "./instances.js";
import { requestBridgeResult, requestEditorContext } from "./rpc-client.js";

if (process.argv.includes("--version")) {
  process.stdout.write(`${BRIDGE_RELEASE_VERSION}\n`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) {
  process.stdout.write(
    `${JSON.stringify({
      name: BRIDGE_NAME,
      version: BRIDGE_RELEASE_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      platform: process.platform,
      architecture: process.arch,
    })}\n`,
  );
  process.exit(0);
}

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
    version: BRIDGE_RELEASE_VERSION,
  },
  {
    instructions:
      "Use this server only for IDE-native VS Code state, unsaved buffers, diagnostics, and language services. Use filesystem and shell tools for ordinary file operations. Call vscode_list_instances before targeting a window when multiple VS Code instances may be open. All current tools are read-only. Remote VS Code extension hosts are not supported.",
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
      const instances = (await discoverLiveInstances()).map(toPublicInstance);
      return toolSuccess(
        instances.length === 0
          ? "No registered VS Code instances were found."
          : `Found ${instances.length} registered VS Code instance(s).`,
        { instances },
      );
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
      const descriptor = await resolveInstance(instanceId);
      const context = await requestEditorContext(descriptor);
      return toolSuccess(
        context.activeEditor
          ? `Active editor: ${context.activeEditor.uri}`
          : "The selected VS Code window has no active text editor.",
        context,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_read_document",
  {
    title: "Read VS Code document buffer",
    description:
      "Read a VS Code text document buffer, including unsaved content. Omit uri to target the active editor.",
    inputSchema: ReadDocumentInputSchema,
    outputSchema: DocumentSnapshotSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ReadDocumentParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.readDocument,
        params,
        (value) => DocumentSnapshotSchema.parse(value),
      );
      return toolSuccess(
        `Read ${result.returnedCharacters} character(s) from ${result.uri}${result.truncated ? " (truncated)" : ""}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_get_diagnostics",
  {
    title: "Get VS Code diagnostics",
    description:
      "Return bounded diagnostics for the active document, a specified document, or the current workspace.",
    inputSchema: DiagnosticsInputSchema,
    outputSchema: DiagnosticsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = DiagnosticsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.getDiagnostics,
        params,
        (value) => DiagnosticsResultSchema.parse(value),
      );
      return toolSuccess(
        `Returned ${result.returnedCount} of ${result.totalCount} diagnostic(s).`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_get_document_symbols",
  {
    title: "Get VS Code document symbols",
    description:
      "Return a bounded, normalized symbol list for a VS Code document. Omit uri to target the active editor.",
    inputSchema: DocumentSymbolsInputSchema,
    outputSchema: DocumentSymbolsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = DocumentSymbolsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.getDocumentSymbols,
        params,
        (value) => DocumentSymbolsResultSchema.parse(value),
      );
      return toolSuccess(
        `Returned ${result.returnedCount} of ${result.totalCount} symbol(s) for ${result.uri}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

registerLocationsTool(
  "vscode_get_definitions",
  "Get VS Code definitions",
  "Return definition locations for an explicit document URI and zero-based position.",
  BRIDGE_METHODS.getDefinitions,
);

registerLocationsTool(
  "vscode_get_references",
  "Get VS Code references",
  "Return reference locations for an explicit document URI and zero-based position.",
  BRIDGE_METHODS.getReferences,
);

server.registerTool(
  "vscode_get_hover",
  {
    title: "Get VS Code hover information",
    description:
      "Return bounded hover text for an explicit document URI and zero-based position. Command links are never executed.",
    inputSchema: HoverInputSchema,
    outputSchema: HoverResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = HoverParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.getHover,
        params,
        (value) => HoverResultSchema.parse(value),
      );
      return toolSuccess(
        result.contents.length === 0
          ? `No hover information was returned for ${result.uri}.`
          : `Returned ${result.returnedCharacters} hover character(s) for ${result.uri}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

function registerLocationsTool(
  name: "vscode_get_definitions" | "vscode_get_references",
  title: string,
  description: string,
  method: string,
): void {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: PositionedDocumentInputSchema,
      outputSchema: LocationsResultSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ instanceId, ...rawParams }) => {
      try {
        const descriptor = await resolveInstance(instanceId);
        const params = PositionedDocumentParamsSchema.parse(rawParams);
        const result = await requestBridgeResult(descriptor, method, params, (value) =>
          LocationsResultSchema.parse(value),
        );
        return toolSuccess(
          `Returned ${result.returnedCount} of ${result.totalCount} location(s) for ${result.uri}.`,
          result,
        );
      } catch (error) {
        return toolError(asBridgeError(error));
      }
    },
  );
}

async function resolveInstance(instanceId?: string): Promise<InstanceDescriptor> {
  return selectInstance(await discoverLiveInstances(), instanceId);
}

function toolSuccess<StructuredContent extends Record<string, unknown>>(
  text: string,
  structuredContent: StructuredContent,
): {
  content: [{ type: "text"; text: string }];
  structuredContent: StructuredContent;
} {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function toolError(error: BridgeError): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const message =
    error.code === "INTERNAL_ERROR" ? "The VS Code bridge encountered an internal error." : error.message;
  console.error(`[${error.code}] Bridge tool request failed.`);
  return {
    content: [{ type: "text", text: `${error.code}: ${message}` }],
    isError: true,
  };
}

await server.connect(new StdioServerTransport());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
