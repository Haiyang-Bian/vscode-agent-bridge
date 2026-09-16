import {
  BRIDGE_METHODS,
  GetWorkspaceConfigurationParamsSchema,
  UpdateWorkspaceConfigurationParamsSchema,
  UpdateWorkspaceConfigurationResultSchema,
  WorkspaceConfigurationResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import {
  toActivityTargets,
  type BridgeRequestHandler,
} from "./request-handlers.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";
import { assertRequestActive } from "./workspace-setup.js";

export function createWorkspaceConfigurationRequestHandlers(
  configurations: WorkspaceConfigurationManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.getWorkspaceConfiguration,
      async (params) =>
        WorkspaceConfigurationResultSchema.parse(
          await configurations.getConfiguration(GetWorkspaceConfigurationParamsSchema.parse(params)),
        ),
    ],
    [
      BRIDGE_METHODS.updateWorkspaceConfiguration,
      async (params, context) => {
        const parsed = UpdateWorkspaceConfigurationParamsSchema.parse(params);
        return activity.track(
          {
            toolName: "vscode_update_workspace_configuration",
            title: `Update ${parsed.target} configuration`,
            reason: parsed.reason,
          },
          async () => {
            assertRequestActive(context.signal);
            return UpdateWorkspaceConfigurationResultSchema.parse(
              await configurations.updateConfiguration(parsed),
            );
          },
          (result) => ({
            targets: toActivityTargets([result.uri]),
            fileCount: 1,
            locations: [{ kind: "uri", uri: result.uri }],
          }),
        );
      },
    ],
  ]);
}
