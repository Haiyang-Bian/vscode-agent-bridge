import {
  BRIDGE_METHODS,
  ExtensionConfigurationResultSchema,
  GetExtensionConfigurationParamsSchema,
  UpdateExtensionConfigurationParamsSchema,
  UpdateExtensionConfigurationResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExtensionProfileManager } from "./extension-profile-manager.js";
import { type BridgeRequestHandler } from "./request-handlers.js";
import { assertRequestActive } from "./workspace-setup.js";

export function createExtensionProfileRequestHandlers(
  profiles: ExtensionProfileManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getExtensionConfiguration,
      (params) => ExtensionConfigurationResultSchema.parse(
        profiles.getConfiguration(GetExtensionConfigurationParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.updateExtensionConfiguration,
      async (params, context) => {
        const parsed = UpdateExtensionConfigurationParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_update_extension_configuration",
            title: `Update ${parsed.extensionId} configuration`,
            reason: parsed.reason,
          },
          async () => {
            assertRequestActive(context.signal);
            return UpdateExtensionConfigurationResultSchema.parse(
              await profiles.updateConfiguration(parsed),
            );
          },
          (result) => ({
            status: result.changed ? "succeeded" : "no-op",
            targets: [result.extensionId],
          }),
        );
      },
    ],
  ]);
}
