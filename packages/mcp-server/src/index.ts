#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  BRIDGE_METHODS,
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  AppliedChangeSetSchema,
  ApplyCodeActionInputSchema,
  ApplyCodeActionParamsSchema,
  ApplyCodeActionResultSchema,
  ApplyChangeSetInputSchema,
  ApplyChangeSetParamsSchema,
  CreateExperimentCheckpointInputSchema,
  CreateExperimentCheckpointParamsSchema,
  CreateExperimentCheckpointResultSchema,
  DiagnosticsInputSchema,
  DiagnosticsParamsSchema,
  DiagnosticsResultSchema,
  DocumentSnapshotSchema,
  DocumentSymbolsInputSchema,
  DocumentSymbolsParamsSchema,
  DocumentSymbolsResultSchema,
  EditorContextSchema,
  ExperimentCheckpointsResultSchema,
  ExperimentEvidenceSchema,
  ExperimentInfoSchema,
  ExperimentsResultSchema,
  FormatDocumentInputSchema,
  FormatDocumentParamsSchema,
  FormatDocumentResultSchema,
  GetExperimentInputSchema,
  GetWorkspaceSetupInputSchema,
  GetWorkspaceSetupParamsSchema,
  HoverInputSchema,
  HoverParamsSchema,
  HoverResultSchema,
  LocationsResultSchema,
  ListExperimentCheckpointsInputSchema,
  ListExperimentCheckpointsParamsSchema,
  ListExperimentsInputSchema,
  ListExperimentsParamsSchema,
  ListCodeActionsInputSchema,
  ListCodeActionsParamsSchema,
  ListCodeActionsResultSchema,
  ListTerminalExecutionsInputSchema,
  ListTerminalExecutionsParamsSchema,
  ListTerminalExecutionsResultSchema,
  ListTerminalsInputSchema,
  ListTerminalsParamsSchema,
  ListTerminalsResultSchema,
  PositionedDocumentInputSchema,
  PositionedDocumentParamsSchema,
  PublicInstanceSchema,
  PreparedChangeSetSchema,
  PrepareRenameInputSchema,
  PrepareRenameParamsSchema,
  PrepareTextEditsInputSchema,
  PrepareTextEditsParamsSchema,
  ReadDocumentInputSchema,
  ReadDocumentParamsSchema,
  ReadTerminalOutputInputSchema,
  ReadTerminalOutputParamsSchema,
  ReadTerminalOutputResultSchema,
  RecordExperimentEvidenceInputSchema,
  RecordExperimentEvidenceParamsSchema,
  RenameExperimentInputSchema,
  RenameExperimentParamsSchema,
  SaveDocumentInputSchema,
  SaveDocumentParamsSchema,
  SaveDocumentResultSchema,
  StartExperimentInputSchema,
  StartExperimentParamsSchema,
  WorkspaceSetupResultSchema,
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
      "Prefer this VS Code Bridge over filesystem or shell tools whenever it offers the needed IDE capability. Inspect workspace setup before starting work, and use a concise experiment title derived from the user's task. The Bridge exposes unsaved buffers, language services, guarded text edits, formatting, pure-text Code Actions, saving existing documents, bounded experiment management, and read-only terminal observation. The Agent may start, rename, and checkpoint ordinary experiments, but acceptance, restore, finalization, abandonment, deletion, pinning, Managed Worktree operations, formal Git history, and terminal input remain user-only. Call vscode_list_instances before targeting a window when multiple VS Code instances may be open. Every mutation is constrained by explicit routing, state or document preconditions, workspace trust, and active policy. Remote VS Code extension hosts are unsupported.",
  },
);

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const prepareAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const guardedWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
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
  "vscode_get_workspace_setup",
  {
    title: "Get VS Code workspace experiment setup",
    description:
      "Inspect one workspace root's experiment onboarding state and the presence of VS Code settings, launch, tasks, and workspace files without returning their contents.",
    inputSchema: GetWorkspaceSetupInputSchema,
    outputSchema: WorkspaceSetupResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = GetWorkspaceSetupParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.getWorkspaceSetup,
        params,
        (value) => WorkspaceSetupResultSchema.parse(value),
      );
      return toolSuccess(
        `Workspace experiment onboarding is ${result.onboarding}; ${result.files.filter((file) => file.state === "present").length} setup file(s) are present.`,
        result,
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

server.registerTool(
  "vscode_get_experiment",
  {
    title: "Get active VS Code experiment",
    description:
      "Return the user-started experiment active in one VS Code window, including health, accepted checkpoint, and local storage status.",
    inputSchema: GetExperimentInputSchema,
    outputSchema: ExperimentInfoSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.getExperiment,
        {},
        (value) => ExperimentInfoSchema.parse(value),
      );
      return toolSuccess(`Active experiment: ${result.title} (${result.sessionId}).`, result);
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_list_experiments",
  {
    title: "List VS Code experiments",
    description:
      "Return a bounded metadata-only page of ordinary and managed experiments for one selected workspace root.",
    inputSchema: ListExperimentsInputSchema,
    outputSchema: ExperimentsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ListExperimentsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.listExperiments,
        params,
        (value) => ExperimentsResultSchema.parse(value),
      );
      return toolSuccess(
        `Returned ${result.returnedCount} of ${result.totalCount} experiment(s) for the selected root.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_start_experiment",
  {
    title: "Start ordinary VS Code experiment",
    description:
      "Start one ordinary recoverable experiment with a task-derived title. First use may wait for explicit workspace onboarding confirmation in VS Code.",
    inputSchema: StartExperimentInputSchema,
    outputSchema: ExperimentInfoSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = StartExperimentParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.startExperiment,
        params,
        (value) => ExperimentInfoSchema.parse(value),
      );
      return toolSuccess(`Started experiment ${result.title} (${result.sessionId}).`, result);
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_rename_experiment",
  {
    title: "Rename ordinary VS Code experiment",
    description:
      "Rename an ordinary experiment after checking its session ID and expected current title. Managed experiments and lifecycle changes are not supported.",
    inputSchema: RenameExperimentInputSchema,
    outputSchema: ExperimentInfoSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = RenameExperimentParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.renameExperiment,
        params,
        (value) => ExperimentInfoSchema.parse(value),
      );
      return toolSuccess(`Renamed experiment to ${result.title}.`, result);
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_create_experiment_checkpoint",
  {
    title: "Create VS Code experiment checkpoint",
    description:
      "Flush pending ordinary-experiment observations, reconcile Git state, and create one explicit recovery checkpoint without committing.",
    inputSchema: CreateExperimentCheckpointInputSchema,
    outputSchema: CreateExperimentCheckpointResultSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = CreateExperimentCheckpointParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.createExperimentCheckpoint,
        params,
        (value) => CreateExperimentCheckpointResultSchema.parse(value),
      );
      return toolSuccess(
        `Created explicit checkpoint ${result.checkpoint.checkpointId}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_list_experiment_checkpoints",
  {
    title: "List VS Code experiment checkpoints",
    description:
      "Return a bounded page of recovery checkpoints and validation evidence for an active experiment.",
    inputSchema: ListExperimentCheckpointsInputSchema,
    outputSchema: ExperimentCheckpointsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ListExperimentCheckpointsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.listExperimentCheckpoints,
        params,
        (value) => ExperimentCheckpointsResultSchema.parse(value),
      );
      return toolSuccess(
        `Returned ${result.returnedCount} of ${result.totalCount} experiment checkpoint(s).`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_prepare_text_edits",
  {
    title: "Prepare guarded VS Code text edits",
    description:
      "Validate bounded text edits against explicit document versions and SHA-256 hashes, then return a ten-minute one-time change set without modifying documents.",
    inputSchema: PrepareTextEditsInputSchema,
    outputSchema: PreparedChangeSetSchema,
    annotations: prepareAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = PrepareTextEditsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.prepareTextEdits,
        params,
        (value) => PreparedChangeSetSchema.parse(value),
      );
      return toolSuccess(
        `Prepared ${result.editCount} edit(s) across ${result.documents.length} document(s); no document was changed.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_prepare_rename",
  {
    title: "Prepare guarded VS Code rename",
    description:
      "Ask the VS Code rename provider for text-only edits, validate their scope and hashes, and return a one-time change set without applying it.",
    inputSchema: PrepareRenameInputSchema,
    outputSchema: PreparedChangeSetSchema,
    annotations: prepareAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = PrepareRenameParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.prepareRename,
        params,
        (value) => PreparedChangeSetSchema.parse(value),
      );
      return toolSuccess(
        `Prepared rename with ${result.editCount} edit(s) across ${result.documents.length} document(s); no document was changed.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_apply_change_set",
  {
    title: "Apply guarded VS Code change set",
    description:
      "Consume one prepared change set after revalidating every document, apply text edits to VS Code buffers, leave them unsaved, and create an experiment checkpoint.",
    inputSchema: ApplyChangeSetInputSchema,
    outputSchema: AppliedChangeSetSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ApplyChangeSetParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.applyChangeSet,
        params,
        (value) => AppliedChangeSetSchema.parse(value),
      );
      return toolSuccess(
        `Applied change set to ${result.documents.length} dirty VS Code buffer(s) and created checkpoint ${result.checkpointId}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_record_experiment_evidence",
  {
    title: "Record VS Code experiment evidence",
    description:
      "Attach a bounded client-reported test, build, or lint result to one experiment checkpoint. This tool records metadata and never executes a command.",
    inputSchema: RecordExperimentEvidenceInputSchema,
    outputSchema: ExperimentEvidenceSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = RecordExperimentEvidenceParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.recordExperimentEvidence,
        params,
        (value) => ExperimentEvidenceSchema.parse(value),
      );
      return toolSuccess(
        `Recorded client-reported ${result.kind} evidence with status ${result.status}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_save_document",
  {
    title: "Save guarded VS Code document",
    description:
      "Save one existing open file document after revalidating its version and SHA-256, then capture the final format-on-save result as an experiment checkpoint.",
    inputSchema: SaveDocumentInputSchema,
    outputSchema: SaveDocumentResultSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = SaveDocumentParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.saveDocument,
        params,
        (value) => SaveDocumentResultSchema.parse(value),
      );
      return toolSuccess(
        `Saved ${result.uri} and created checkpoint ${result.checkpointId}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_format_document",
  {
    title: "Format guarded VS Code document",
    description:
      "Apply text edits from VS Code's document formatter after version and SHA-256 validation. The document remains unsaved.",
    inputSchema: FormatDocumentInputSchema,
    outputSchema: FormatDocumentResultSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = FormatDocumentParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.formatDocument,
        params,
        (value) => FormatDocumentResultSchema.parse(value),
      );
      return toolSuccess(
        result.applied
          ? `Applied ${result.editCount} formatter edit(s) to ${result.uri}; the buffer remains unsaved.`
          : `The formatter returned no edits for ${result.uri}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_list_code_actions",
  {
    title: "List guarded VS Code Code Actions",
    description:
      "Query VS Code Code Actions for an explicit document range. Returned action handles expire after ten minutes; command arguments are never exposed.",
    inputSchema: ListCodeActionsInputSchema,
    outputSchema: ListCodeActionsResultSchema,
    annotations: prepareAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ListCodeActionsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.listCodeActions,
        params,
        (value) => ListCodeActionsResultSchema.parse(value),
      );
      return toolSuccess(
        `Returned ${result.returnedCount} of ${result.totalCount} Code Action(s) for ${result.uri}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_apply_code_action",
  {
    title: "Apply guarded VS Code Code Action",
    description:
      "Consume one Code Action containing only text edits, revalidate every document, apply it atomically, leave buffers unsaved, and create an experiment checkpoint.",
    inputSchema: ApplyCodeActionInputSchema,
    outputSchema: ApplyCodeActionResultSchema,
    annotations: guardedWriteAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ApplyCodeActionParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.applyCodeAction,
        params,
        (value) => ApplyCodeActionResultSchema.parse(value),
      );
      return toolSuccess(
        `Applied Code Action to ${result.documents.length} dirty buffer(s) and created checkpoint ${result.checkpointId}.`,
        result,
      );
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_list_terminals",
  {
    title: "List VS Code terminals",
    description:
      "Return terminal metadata and read coverage for one VS Code window. This tool cannot create, focus, close, or write to a terminal.",
    inputSchema: ListTerminalsInputSchema,
    outputSchema: ListTerminalsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ListTerminalsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.listTerminals,
        params,
        (value) => ListTerminalsResultSchema.parse(value),
      );
      return toolSuccess(`Returned ${result.returnedCount} terminal(s).`, result);
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_list_terminal_executions",
  {
    title: "List observed VS Code terminal executions",
    description:
      "Page through Shell Integration command executions captured since extension activation, including explicit output coverage and exit status.",
    inputSchema: ListTerminalExecutionsInputSchema,
    outputSchema: ListTerminalExecutionsResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ListTerminalExecutionsParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.listTerminalExecutions,
        params,
        (value) => ListTerminalExecutionsResultSchema.parse(value),
      );
      return toolSuccess(`Returned ${result.returnedCount} terminal execution(s).`, result);
    } catch (error) {
      return toolError(asBridgeError(error));
    }
  },
);

server.registerTool(
  "vscode_read_terminal_output",
  {
    title: "Read captured VS Code terminal output",
    description:
      "Read a bounded page of sanitized output captured after a Shell Integration execution started. Coverage can be partial and no terminal input is possible.",
    inputSchema: ReadTerminalOutputInputSchema,
    outputSchema: ReadTerminalOutputResultSchema,
    annotations: readOnlyAnnotations,
  },
  async ({ instanceId, ...rawParams }) => {
    try {
      const descriptor = await resolveInstance(instanceId);
      const params = ReadTerminalOutputParamsSchema.parse(rawParams);
      const result = await requestBridgeResult(
        descriptor,
        BRIDGE_METHODS.readTerminalOutput,
        params,
        (value) => ReadTerminalOutputResultSchema.parse(value),
      );
      return toolSuccess(
        `Read ${result.returnedCharacters} captured terminal character(s) with ${result.coverage} coverage.`,
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
