import {
  BRIDGE_METHODS,
  ListTaskExecutionsParamsSchema,
  ListTaskExecutionsResultSchema,
  ListTasksParamsSchema,
  ListTasksResultSchema,
  PersistTaskParamsSchema,
  PersistTaskResultSchema,
  PrepareTaskParamsSchema,
  PrepareTaskResultSchema,
  RunTaskParamsSchema,
  RunTaskResultSchema,
  TerminateTaskParamsSchema,
  TerminateTaskResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { type BridgeRequestHandler } from "./request-handlers.js";
import { TaskManager } from "./task-manager.js";
import { assertRequestActive } from "./workspace-setup.js";

export function createTaskRequestHandlers(
  tasks: TaskManager,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.prepareTask,
      async (params, context) => {
        const parsed = PrepareTaskParamsSchema.parse(params);
        assertRequestActive(context.signal);
        return PrepareTaskResultSchema.parse(await tasks.prepareTask(parsed));
      },
    ],
    [
      BRIDGE_METHODS.persistTask,
      async (params, context) => {
        const parsed = PersistTaskParamsSchema.parse(params);
        assertRequestActive(context.signal);
        return PersistTaskResultSchema.parse(await tasks.persistTask(parsed));
      },
    ],
    [
      BRIDGE_METHODS.listTasks,
      async (params) => ListTasksResultSchema.parse(await tasks.listTasks(ListTasksParamsSchema.parse(params))),
    ],
    [
      BRIDGE_METHODS.runTask,
      async (params, context) => {
        const parsed = RunTaskParamsSchema.parse(params);
        assertRequestActive(context.signal);
        return RunTaskResultSchema.parse(await tasks.runTask(parsed));
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
            assertRequestActive(context.signal);
            return TerminateTaskResultSchema.parse(await tasks.terminateTask(parsed));
          },
        );
      },
    ],
  ]);
}
