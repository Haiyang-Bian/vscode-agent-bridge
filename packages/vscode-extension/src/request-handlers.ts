import { z } from "zod";

import {
  BRIDGE_METHODS,
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
  ExperimentCheckpointsResultSchema,
  ExperimentEvidenceSchema,
  ExperimentInfoSchema,
  ListExperimentCheckpointsParamsSchema,
  PreparedChangeSetSchema,
  PrepareRenameParamsSchema,
  PrepareTextEditsParamsSchema,
  ReadDocumentParamsSchema,
  RecordExperimentEvidenceParamsSchema,
} from "@vscode-agent-bridge/protocol";

import { ChangeSetManager } from "./change-set-manager.js";
import { getEditorContext } from "./editor-context.js";
import { ExperimentManager } from "./experiment-manager.js";
import {
  getDefinitions,
  getDiagnostics,
  getDocumentSymbols,
  getHover,
  getReferences,
  readDocument,
} from "./language-services.js";

export type BridgeRequestHandler = (params: unknown) => Promise<unknown> | unknown;

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

export function createExperimentRequestHandlers(
  instanceId: string,
  experiments: ExperimentManager,
  changeSets: ChangeSetManager,
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
      async (params) =>
        AppliedChangeSetSchema.parse(
          await changeSets.apply(ApplyChangeSetParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.recordExperimentEvidence,
      async (params) =>
        ExperimentEvidenceSchema.parse(
          await experiments.recordClientEvidence(
            RecordExperimentEvidenceParamsSchema.parse(params),
          ),
        ),
    ],
  ]);
}
