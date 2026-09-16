import { z } from "zod";
import * as vscode from "vscode";

import {
  BRIDGE_METHODS,
  ApplyCodeActionParamsSchema,
  ApplyCodeActionResultSchema,
  DiagnosticsParamsSchema,
  DiagnosticsResultSchema,
  DocumentSnapshotSchema,
  DocumentSymbolsParamsSchema,
  DocumentSymbolsResultSchema,
  EditorContextSchema,
  HoverParamsSchema,
  HoverResultSchema,
  LocationsResultSchema,
  PositionedDocumentParamsSchema,
  AppliedChangeSetSchema,
  ApplyChangeSetParamsSchema,
  FormatDocumentParamsSchema,
  FormatDocumentResultSchema,
  GetWorkspaceSetupParamsSchema,
  ListCodeActionsParamsSchema,
  ListCodeActionsResultSchema,
  ListTerminalExecutionsParamsSchema,
  ListTerminalExecutionsResultSchema,
  ListTerminalsParamsSchema,
  ListTerminalsResultSchema,
  PreparedChangeSetSchema,
  PrepareRenameParamsSchema,
  PrepareResourceChangesParamsSchema,
  PrepareTextEditsParamsSchema,
  ReadDocumentParamsSchema,
  ReadTerminalOutputParamsSchema,
  ReadTerminalOutputResultSchema,
  SaveDocumentParamsSchema,
  SaveDocumentResultSchema,
  WorkspaceSetupResultSchema,
} from "@vscode-agent-bridge/protocol";

import { ChangeSetManager } from "./change-set-manager.js";
import { AgentActivityTracker } from "./agent-activity.js";
import { DocumentAccessController } from "./document-access-controller.js";
import { getEditorContext } from "./editor-context.js";
import { IdeAutonomyManager } from "./ide-autonomy-manager.js";
import {
  assertAgentWriteAllowed,
  assertTerminalExecutionAccess,
  assertTerminalMetadataAllowed,
} from "./policies.js";
import { TerminalObserver } from "./terminal-observer.js";
import { WorkspaceSetupService, assertRequestActive } from "./workspace-setup.js";
import {
  getDefinitions,
  getDiagnostics,
  getDocumentSymbols,
  getHover,
  getReferences,
  readDocument,
} from "./language-services.js";

export interface BridgeRequestContext {
  readonly signal: AbortSignal;
}

export type BridgeRequestHandler = (
  params: unknown,
  context: BridgeRequestContext,
) => Promise<unknown> | unknown;

const EmptyParamsSchema = z.object({}).strict();

export function createRequestHandlers(
  instanceId: string,
  access: DocumentAccessController,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getEditorContext,
      (params) => {
        EmptyParamsSchema.parse(params);
        return EditorContextSchema.parse(getEditorContext(instanceId));
      },
    ],
    [
      BRIDGE_METHODS.readDocument,
      async (params) =>
        DocumentSnapshotSchema.parse(
          await readDocument(instanceId, ReadDocumentParamsSchema.parse(params), access),
        ),
    ],
    [
      BRIDGE_METHODS.getDiagnostics,
      async (params) =>
        DiagnosticsResultSchema.parse(
          await getDiagnostics(instanceId, DiagnosticsParamsSchema.parse(params), access),
        ),
    ],
    [
      BRIDGE_METHODS.getDocumentSymbols,
      async (params) =>
        DocumentSymbolsResultSchema.parse(
          await getDocumentSymbols(instanceId, DocumentSymbolsParamsSchema.parse(params), access),
        ),
    ],
    [
      BRIDGE_METHODS.getDefinitions,
      async (params) =>
        LocationsResultSchema.parse(
          await getDefinitions(instanceId, PositionedDocumentParamsSchema.parse(params), access),
        ),
    ],
    [
      BRIDGE_METHODS.getReferences,
      async (params) =>
        LocationsResultSchema.parse(
          await getReferences(instanceId, PositionedDocumentParamsSchema.parse(params), access),
        ),
    ],
    [
      BRIDGE_METHODS.getHover,
      async (params) =>
        HoverResultSchema.parse(await getHover(instanceId, HoverParamsSchema.parse(params), access)),
    ],
  ]);
}

export function createWorkspaceRequestHandlers(
  setup: WorkspaceSetupService,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getWorkspaceSetup,
      async (params) =>
        WorkspaceSetupResultSchema.parse(
          await setup.getSetup(GetWorkspaceSetupParamsSchema.parse(params)),
        ),
    ],
  ]);
}

export function createChangeRequestHandlers(
  changeSets: ChangeSetManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.prepareTextEdits,
      async (params) => PreparedChangeSetSchema.parse(
        await changeSets.prepareTextEdits(PrepareTextEditsParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.prepareRename,
      async (params) => PreparedChangeSetSchema.parse(
        await changeSets.prepareRename(PrepareRenameParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.prepareResourceChanges,
      async (params) => PreparedChangeSetSchema.parse(
        await changeSets.prepareResourceChanges(PrepareResourceChangesParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.applyChangeSet,
      async (params, context) => {
        const parsed = ApplyChangeSetParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_apply_change_set", title: "Apply prepared changes" },
          async () => {
            assertRequestActive(context.signal);
            return AppliedChangeSetSchema.parse(await changeSets.apply(parsed));
          },
          (result) => ({
            targets: toActivityTargets([
              ...result.documents.map((document) => document.uri),
              ...result.resources.flatMap((resource) =>
                resource.operation === "rename" ? [resource.uri, resource.targetUri] : [resource.uri],
              ),
            ]),
            fileCount: result.documents.length + result.resources.length,
            locations: [...result.documents.map((document) => ({ kind: "uri" as const, uri: document.uri })),
              ...result.resources.map((resource) => ({ kind: "uri" as const, uri: resource.uri }))],
          }),
        );
      },
    ],
  ]);
}

export function createIdeAutonomyRequestHandlers(
  manager: IdeAutonomyManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.saveDocument,
      async (params, context) => {
        const parsed = SaveDocumentParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_save_document",
            title: "Save document",
            reason: parsed.reason,
            targets: toActivityTargets([parsed.uri]),
          },
          async () => {
            assertRequestActive(context.signal);
            return SaveDocumentResultSchema.parse(await manager.saveDocument(parsed));
          },
          (result) => ({
            targets: toActivityTargets([result.uri]),
            fileCount: 1,
            locations: [{ kind: "uri", uri: result.uri }],
          }),
        );
      },
    ],
    [
      BRIDGE_METHODS.formatDocument,
      async (params, context) => {
        const parsed = FormatDocumentParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_format_document",
            title: "Format document",
            reason: parsed.reason,
            targets: toActivityTargets([parsed.uri]),
          },
          async () => {
            assertRequestActive(context.signal);
            return FormatDocumentResultSchema.parse(await manager.formatDocument(parsed));
          },
          (result) => ({
            status: result.applied ? "succeeded" : "no-op",
            targets: toActivityTargets([result.uri]),
            fileCount: result.applied ? 1 : 0,
            editCount: result.editCount,
            locations: [{ kind: "uri", uri: result.uri }],
          }),
        );
      },
    ],
    [
      BRIDGE_METHODS.listCodeActions,
      async (params) => ListCodeActionsResultSchema.parse(
        await manager.listCodeActions(ListCodeActionsParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.applyCodeAction,
      async (params, context) => {
        const parsed = ApplyCodeActionParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_apply_code_action",
            title: "Apply pure-text Code Action",
            reason: parsed.reason,
          },
          async () => {
            assertRequestActive(context.signal);
            return ApplyCodeActionResultSchema.parse(await manager.applyCodeAction(parsed));
          },
          (result) => ({
            targets: toActivityTargets(result.documents.map((document) => document.uri)),
            fileCount: result.documents.length,
            locations: result.documents.map((document) => ({ kind: "uri" as const, uri: document.uri })),
          }),
        );
      },
    ],
  ]);
}

export function toActivityTargets(uris: readonly string[]): string[] {
  return uris.map((uri) => {
    try {
      return vscode.workspace.asRelativePath(vscode.Uri.parse(uri, true), false);
    } catch {
      return "document";
    }
  });
}
export function createTerminalRequestHandlers(
  observer: TerminalObserver,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.listTerminals,
      (params) => {
        ListTerminalsParamsSchema.parse(params);
        return ListTerminalsResultSchema.parse(observer.listTerminals(assertTerminalMetadataAllowed()));
      },
    ],
    [
      BRIDGE_METHODS.listTerminalExecutions,
      (params) => {
        assertTerminalExecutionAccess();
        return ListTerminalExecutionsResultSchema.parse(
          observer.listExecutions(ListTerminalExecutionsParamsSchema.parse(params)),
        );
      },
    ],
    [
      BRIDGE_METHODS.readTerminalOutput,
      (params) => {
        assertTerminalExecutionAccess();
        return ReadTerminalOutputResultSchema.parse(
          observer.readOutput(ReadTerminalOutputParamsSchema.parse(params)),
        );
      },
    ],
  ]);
}
