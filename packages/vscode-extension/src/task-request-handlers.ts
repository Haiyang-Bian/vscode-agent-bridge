import {
  BRIDGE_METHODS,
  ListTaskExecutionsParamsSchema,
  ListTaskExecutionsResultSchema,
  ListTasksParamsSchema,
  ListTasksResultSchema,
  RunTaskParamsSchema,
  RunTaskResultSchema,
  TerminateTaskParamsSchema,
  TerminateTaskResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { ExperimentManager } from "./experiment-manager.js";
import {
  ensureSessionWorkspaceEnabled,
  type BridgeRequestHandler,
} from "./request-handlers.js";
import { TaskManager } from "./task-manager.js";
import { WorkspaceOnboardingService, assertRequestActive } from "./workspace-onboarding.js";

export function createTaskRequestHandlers(
  tasks: TaskManager,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.listTasks,
      async (params) => ListTasksResultSchema.parse(await tasks.listTasks(ListTasksParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.runTask,
      async (params, context) => {
        const parsed = RunTaskParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_run_task", title: "Run workspace task", reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return RunTaskResultSchema.parse(await tasks.runTask(parsed));
          },
        );
      },
    ],
    [
      BRIDGE_METHODS.listTaskExecutions,
      (params) => ListTaskExecutionsResultSchema.parse(
        tasks.listTaskExecutions(ListTaskExecutionsParamsSchema.parse(params)),
      ),
    ],
    [
      BRIDGE_METHODS.terminateTask,
      async (params, context) => {
        const parsed = TerminateTaskParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_terminate_task", title: "Terminate workspace task", reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return TerminateTaskResultSchema.parse(await tasks.terminateTask(parsed));
          },
        );
      },
    ],
  ]);
}
