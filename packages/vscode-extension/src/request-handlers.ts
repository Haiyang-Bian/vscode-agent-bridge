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
  ReadDocumentParamsSchema,
} from "@vscode-agent-bridge/protocol";

import { getEditorContext } from "./editor-context.js";
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
