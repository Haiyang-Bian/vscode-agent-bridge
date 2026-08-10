import {
  BRIDGE_METHODS,
  GetWorkspaceConfigurationParamsSchema,
  UpdateWorkspaceConfigurationParamsSchema,
  UpdateWorkspaceConfigurationResultSchema,
  WorkspaceConfigurationResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExperimentManager } from "./experiment-manager.js";
import {
  ensureSessionWorkspaceEnabled,
  toActivityTargets,
  type BridgeRequestHandler,
} from "./request-handlers.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";
import { WorkspaceOnboardingService, assertRequestActive } from "./workspace-onboarding.js";

export function createWorkspaceConfigurationRequestHandlers(
  configurations: WorkspaceConfigurationManager,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
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
            await ensureSessionWorkspaceEnabled(
              experiments,
              onboarding,
              parsed.sessionId,
              context.signal,
            );
            assertRequestActive(context.signal);
            return UpdateWorkspaceConfigurationResultSchema.parse(
              await configurations.updateConfiguration(parsed),
            );
          },
          (result) => ({
            targets: toActivityTargets([result.uri]),
            fileCount: 1,
            checkpointId: result.checkpointId,
          }),
        );
      },
    ],
  ]);
}
