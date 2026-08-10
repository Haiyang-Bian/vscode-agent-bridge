import {
  BRIDGE_METHODS,
  ExtensionIntegrationStateResultSchema,
  GetExtensionIntegrationStateParamsSchema,
  ListExtensionIntegrationsParamsSchema,
  ListExtensionIntegrationsResultSchema,
} from "@vscode-agent-bridge/protocol";

import { ExtensionIntegrationManager } from "./extension-integration-manager.js";
import type { BridgeRequestHandler } from "./request-handlers.js";

export function createExtensionIntegrationRequestHandlers(
  integrations: ExtensionIntegrationManager,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.listExtensionIntegrations,
      (params) => ListExtensionIntegrationsResultSchema.parse(
        integrations.list(ListExtensionIntegrationsParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.getExtensionIntegrationState,
      async (params) => ExtensionIntegrationStateResultSchema.parse(
        await integrations.getState(GetExtensionIntegrationStateParamsSchema.parse(params)),
      ),
    ],
  ]);
}
