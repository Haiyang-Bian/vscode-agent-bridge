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
  CreateExperimentCheckpointParamsSchema,
  CreateExperimentCheckpointResultSchema,
  ExperimentCheckpointsResultSchema,
  ExperimentEvidenceSchema,
  ExperimentInfoSchema,
  ExperimentsResultSchema,
  FormatDocumentParamsSchema,
  FormatDocumentResultSchema,
  GetWorkspaceSetupParamsSchema,
  ListExperimentCheckpointsParamsSchema,
  ListExperimentsParamsSchema,
  ListCodeActionsParamsSchema,
  ListCodeActionsResultSchema,
  ListTerminalExecutionsParamsSchema,
  ListTerminalExecutionsResultSchema,
  ListTerminalsParamsSchema,
  ListTerminalsResultSchema,
  PreparedChangeSetSchema,
  PrepareRenameParamsSchema,
  PrepareTextEditsParamsSchema,
  ReadDocumentParamsSchema,
  ReadTerminalOutputParamsSchema,
  ReadTerminalOutputResultSchema,
  RecordExperimentEvidenceParamsSchema,
  RenameExperimentParamsSchema,
  SaveDocumentParamsSchema,
  SaveDocumentResultSchema,
  StartExperimentParamsSchema,
  WorkspaceSetupResultSchema,
} from "@vscode-agent-bridge/protocol";

import { ChangeSetManager } from "./change-set-manager.js";
import { AgentActivityTracker } from "./agent-activity.js";
import { getEditorContext } from "./editor-context.js";
import { ExperimentManager } from "./experiment-manager.js";
import { IdeAutonomyManager } from "./ide-autonomy-manager.js";
import {
  assertAgentWriteAllowed,
  assertTerminalExecutionAccess,
  assertTerminalMetadataAllowed,
} from "./policies.js";
import { TerminalObserver } from "./terminal-observer.js";
import {
  WorkspaceOnboardingService,
  assertRequestActive,
} from "./workspace-onboarding.js";
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

export function createRequestHandlers(instanceId: string): ReadonlyMap<string, BridgeRequestHandler> {
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
          await readDocument(instanceId, ReadDocumentParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.getDiagnostics,
      async (params) =>
        DiagnosticsResultSchema.parse(
          await getDiagnostics(instanceId, DiagnosticsParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.getDocumentSymbols,
      async (params) =>
        DocumentSymbolsResultSchema.parse(
          await getDocumentSymbols(instanceId, DocumentSymbolsParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.getDefinitions,
      async (params) =>
        LocationsResultSchema.parse(
          await getDefinitions(instanceId, PositionedDocumentParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.getReferences,
      async (params) =>
        LocationsResultSchema.parse(
          await getReferences(instanceId, PositionedDocumentParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.getHover,
      async (params) =>
        HoverResultSchema.parse(await getHover(instanceId, HoverParamsSchema.parse(params))),
    ],
  ]);
}

export function createWorkspaceRequestHandlers(
  onboarding: WorkspaceOnboardingService,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getWorkspaceSetup,
      async (params) =>
        WorkspaceSetupResultSchema.parse(
          await onboarding.getSetup(GetWorkspaceSetupParamsSchema.parse(params)),
        ),
    ],
  ]);
}

export function createExperimentRequestHandlers(
  instanceId: string,
  experiments: ExperimentManager,
  changeSets: ChangeSetManager,
  onboarding: WorkspaceOnboardingService,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getExperiment,
      async (params) => {
        EmptyParamsSchema.parse(params);
        return ExperimentInfoSchema.parse(await experiments.getActiveExperiment());
      },
    ],
    [
      BRIDGE_METHODS.listExperiments,
      async (params) => {
        const parsed = ListExperimentsParamsSchema.parse(params);
        const root = onboarding.resolveRoot(parsed.rootUri);
        return ExperimentsResultSchema.parse(
          await experiments.listExperiments({
            ...parsed,
            rootUri: root.uri.toString(true),
          }),
        );
      },
    ],
    [
      BRIDGE_METHODS.startExperiment,
      async (params, context) => {
        const parsed = StartExperimentParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_start_experiment",
            title: parsed.title,
            reason: parsed.reason,
          },
          async () => {
            assertAgentWriteAllowed();
            const root = onboarding.resolveRoot(parsed.rootUri);
            await onboarding.ensureEnabled(root, parsed.title, "agent", context.signal);
            assertRequestActive(context.signal);
            return ExperimentInfoSchema.parse(
              await experiments.startWorkspaceExperiment({
                title: parsed.title,
                root: root.uri,
                signal: context.signal,
              }),
            );
          },
        );
      },
    ],
    [
      BRIDGE_METHODS.renameExperiment,
      async (params, context) => {
        const parsed = RenameExperimentParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_rename_experiment",
            title: `Rename experiment to ${parsed.title}`,
            reason: parsed.reason,
          },
          async () => {
            assertAgentWriteAllowed();
            const root = await experiments.resolveExperimentRoot(parsed.sessionId);
            await onboarding.ensureEnabled(root, parsed.title, "agent", context.signal);
            assertRequestActive(context.signal);
            return ExperimentInfoSchema.parse(await experiments.renameOrdinaryExperiment(parsed));
          },
        );
      },
    ],
    [
      BRIDGE_METHODS.createExperimentCheckpoint,
      async (params, context) => {
        const parsed = CreateExperimentCheckpointParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_create_experiment_checkpoint",
            title: parsed.title,
            reason: parsed.reason,
          },
          async () => {
            assertAgentWriteAllowed();
            const root = await experiments.resolveExperimentRoot(parsed.sessionId);
            await onboarding.ensureEnabled(root, parsed.title, "agent", context.signal);
            assertRequestActive(context.signal);
            return CreateExperimentCheckpointResultSchema.parse({
              instanceId,
              sessionId: parsed.sessionId,
              checkpoint: await experiments.createAgentCheckpoint(parsed),
            });
          },
          (result) => ({ checkpointId: result.checkpoint.checkpointId }),
        );
      },
    ],
    [
      BRIDGE_METHODS.listExperimentCheckpoints,
      async (params) =>
        ExperimentCheckpointsResultSchema.parse(
          await experiments.listCheckpoints(ListExperimentCheckpointsParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.prepareTextEdits,
      async (params) =>
        PreparedChangeSetSchema.parse(
          await changeSets.prepareTextEdits(PrepareTextEditsParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.prepareRename,
      async (params) =>
        PreparedChangeSetSchema.parse(
          await changeSets.prepareRename(PrepareRenameParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.applyChangeSet,
      async (params, context) => {
        const parsed = ApplyChangeSetParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_apply_change_set",
            title: "Apply prepared text changes",
          },
          async () => {
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return AppliedChangeSetSchema.parse(await changeSets.apply(parsed));
          },
          (result) => ({
            targets: toActivityTargets(result.documents.map((document) => document.uri)),
            fileCount: result.documents.length,
            checkpointId: result.checkpointId,
          }),
        );
      },
    ],
    [
      BRIDGE_METHODS.recordExperimentEvidence,
      async (params, context) => {
        const parsed = RecordExperimentEvidenceParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_record_experiment_evidence",
            title: `Record ${parsed.kind} evidence`,
            reason: "Record bounded client-reported experiment evidence.",
          },
          async () => {
            assertAgentWriteAllowed();
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return ExperimentEvidenceSchema.parse(
              await experiments.recordClientEvidence(parsed),
            );
          },
          () => ({ checkpointId: parsed.checkpointId }),
        );
      },
    ],
  ]);
}

export function createIdeAutonomyRequestHandlers(
  manager: IdeAutonomyManager,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
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
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return SaveDocumentResultSchema.parse(await manager.saveDocument(parsed));
          },
          (result) => ({ targets: toActivityTargets([result.uri]), fileCount: 1, checkpointId: result.checkpointId }),
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
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return FormatDocumentResultSchema.parse(await manager.formatDocument(parsed));
          },
          (result) => ({
            status: result.applied ? "succeeded" : "no-op",
            targets: toActivityTargets([result.uri]),
            fileCount: result.applied ? 1 : 0,
            editCount: result.editCount,
            checkpointId: result.checkpointId,
          }),
        );
      },
    ],
    [
      BRIDGE_METHODS.listCodeActions,
      async (params) =>
        ListCodeActionsResultSchema.parse(
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
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return ApplyCodeActionResultSchema.parse(await manager.applyCodeAction(parsed));
          },
          (result) => ({
            targets: toActivityTargets(result.documents.map((document) => document.uri)),
            fileCount: result.documents.length,
            checkpointId: result.checkpointId,
          }),
        );
      },
    ],
  ]);
}

function toActivityTargets(uris: readonly string[]): string[] {
  return uris.map((uri) => {
    try {
      return vscode.workspace.asRelativePath(vscode.Uri.parse(uri, true), false);
    } catch {
      return "document";
    }
  });
}

async function ensureSessionWorkspaceEnabled(
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = await experiments.resolveExperimentRoot(sessionId);
  let title = "Agent experiment";
  try {
    title = (await experiments.getActiveExperiment()).title;
  } catch {
    // The downstream operation returns the precise lifecycle error.
  }
  await onboarding.ensureEnabled(root, title, "agent", signal);
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
