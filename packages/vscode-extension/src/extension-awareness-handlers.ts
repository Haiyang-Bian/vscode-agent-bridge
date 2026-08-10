import {
  BRIDGE_METHODS,
  ExtensionConfigurationSchemaResultSchema,
  ExtensionDetailsResultSchema,
  GetExtensionConfigurationSchemaParamsSchema,
  GetExtensionDetailsParamsSchema,
  ListDiagnosticEventsParamsSchema,
  ListDiagnosticEventsResultSchema,
  ListExtensionsParamsSchema,
  ListExtensionsResultSchema,
  ListOutputSourcesParamsSchema,
  ListOutputSourcesResultSchema,
  ProfileContextResultSchema,
  ReadVisibleOutputParamsSchema,
  ReadVisibleOutputResultSchema,
} from "@vscode-agent-bridge/protocol";

import { ExtensionAwarenessManager } from "./extension-awareness-manager.js";
import type { BridgeRequestHandler } from "./request-handlers.js";

export function createExtensionAwarenessRequestHandlers(
  awareness: ExtensionAwarenessManager,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.listExtensions,
      (params) => ListExtensionsResultSchema.parse(awareness.listExtensions(ListExtensionsParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.getExtensionDetails,
      (params) => ExtensionDetailsResultSchema.parse(awareness.getExtensionDetails(GetExtensionDetailsParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.getExtensionConfigurationSchema,
      (params) => ExtensionConfigurationSchemaResultSchema.parse(
        awareness.getExtensionConfigurationSchema(GetExtensionConfigurationSchemaParamsSchema.parse(params)),
      ),
    ],
    [BRIDGE_METHODS.getProfileContext, () => ProfileContextResultSchema.parse(awareness.getProfileContext())],
    [
      BRIDGE_METHODS.listOutputSources,
      (params) => ListOutputSourcesResultSchema.parse(awareness.listOutputSources(ListOutputSourcesParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.readVisibleOutput,
      (params) => ReadVisibleOutputResultSchema.parse(awareness.readVisibleOutput(ReadVisibleOutputParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.listDiagnosticEvents,
      (params) => ListDiagnosticEventsResultSchema.parse(awareness.listDiagnosticEvents(ListDiagnosticEventsParamsSchema.parse(params))),
    ],
  ]);
}
