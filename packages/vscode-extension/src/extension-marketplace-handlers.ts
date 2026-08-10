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
import { ExperimentManager } from "./experiment-manager.js";
import {
  ensureSessionWorkspaceEnabled,
  type BridgeRequestHandler,
} from "./request-handlers.js";
import { WorkspaceOnboardingService, assertRequestActive } from "./workspace-onboarding.js";

export function createExtensionMarketplaceRequestHandlers(
  marketplace: ExtensionMarketplaceManager,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
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
        return activity.track(
          {
            toolName: "vscode_prepare_extension_install",
            title: "Prepare extension installation",
            reason: parsed.reason,
          },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return PreparedExtensionInstallSchema.parse(await marketplace.prepare(parsed));
          },
          () => ({ status: "succeeded" }),
        );
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
            const experiment = await experiments.assertResourceChangesAllowed(parsed.sessionId);
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            if (!experiment.rootUri) throw new Error("The experiment root is unavailable.");
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
