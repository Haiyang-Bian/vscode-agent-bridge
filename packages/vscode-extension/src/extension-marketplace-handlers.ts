import {
  ApplyExtensionInstallParamsSchema,
  ApplyExtensionInstallResultSchema,
  BRIDGE_METHODS,
  PreparedExtensionInstallSchema,
  PrepareExtensionInstallParamsSchema,
  SearchExtensionsParamsSchema,
  SearchExtensionsResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExtensionMarketplaceManager } from "./extension-marketplace-manager.js";
import { type BridgeRequestHandler } from "./request-handlers.js";
import { assertRequestActive } from "./workspace-setup.js";

export function createExtensionMarketplaceRequestHandlers(
  marketplace: ExtensionMarketplaceManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.searchExtensions,
      async (params) => SearchExtensionsResultSchema.parse(
        await marketplace.search(SearchExtensionsParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.prepareExtensionInstall,
      async (params, context) => {
        const parsed = PrepareExtensionInstallParamsSchema.parse(params);
        assertRequestActive(context.signal);
        return PreparedExtensionInstallSchema.parse(await marketplace.prepare(parsed));
      },
    ],
    [
      BRIDGE_METHODS.applyExtensionInstall,
      async (params, context) => {
        const parsed = ApplyExtensionInstallParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_apply_extension_install",
            title: "Apply extension installation",
          },
          async () => {
            assertRequestActive(context.signal);
            return ApplyExtensionInstallResultSchema.parse(await marketplace.apply(parsed));
          },
          (result) => ({
            status: result.status === "alreadyInstalled" ? "no-op" : "succeeded",
            targets: [result.extensionId],
          }),
        );
      },
    ],
  ]);
}
