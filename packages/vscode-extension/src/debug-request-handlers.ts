import {
  BRIDGE_METHODS,
  ControlDebugSessionParamsSchema,
  ControlDebugSessionResultSchema,
  EvaluateDebugExpressionParamsSchema,
  EvaluateDebugExpressionResultSchema,
  GetDebugStateParamsSchema,
  GetDebugStateResultSchema,
  ListBreakpointsParamsSchema,
  ListBreakpointsResultSchema,
  ListDebugConfigurationsParamsSchema,
  ListDebugConfigurationsResultSchema,
  ListDebugOutputParamsSchema,
  ListDebugOutputResultSchema,
  ListDebugSessionsParamsSchema,
  ListDebugSessionsResultSchema,
  PersistDebugConfigurationParamsSchema,
  PersistDebugConfigurationResultSchema,
  PrepareDebugConfigurationParamsSchema,
  PrepareDebugConfigurationResultSchema,
  SetDebugVariableParamsSchema,
  SetDebugVariableResultSchema,
  ReadDebugOutputParamsSchema,
  ReadDebugOutputResultSchema,
  StartDebugSessionParamsSchema,
  StartDebugSessionResultSchema,
  UpdateBreakpointsParamsSchema,
  UpdateBreakpointsResultSchema,
} from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { DebugManager } from "./debug-manager.js";
import { ExperimentManager } from "./experiment-manager.js";
import { ensureSessionWorkspaceEnabled, type BridgeRequestHandler } from "./request-handlers.js";
import { WorkspaceOnboardingService, assertRequestActive } from "./workspace-onboarding.js";

export function createDebugRequestHandlers(
  debug: DebugManager,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
  activity: AgentActivityTracker,
): ReadonlyMap<string, BridgeRequestHandler> {
  return new Map<string, BridgeRequestHandler>([
    [
      BRIDGE_METHODS.prepareDebugConfiguration,
      async (params, context) => {
        const parsed = PrepareDebugConfigurationParamsSchema.parse(params);
        await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
        assertRequestActive(context.signal);
        return PrepareDebugConfigurationResultSchema.parse(await debug.prepareConfiguration(parsed));
      },
    ],
    [
      BRIDGE_METHODS.persistDebugConfiguration,
      async (params, context) => {
        const parsed = PersistDebugConfigurationParamsSchema.parse(params);
        await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
        assertRequestActive(context.signal);
        return PersistDebugConfigurationResultSchema.parse(await debug.persistConfiguration(parsed));
      },
    ],
    [BRIDGE_METHODS.listDebugConfigurations, async (params) => ListDebugConfigurationsResultSchema.parse(await debug.listConfigurations(ListDebugConfigurationsParamsSchema.parse(params)))],
    [
      BRIDGE_METHODS.startDebugSession,
      async (params, context) => {
        const parsed = StartDebugSessionParamsSchema.parse(params);
        await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
        assertRequestActive(context.signal);
        return StartDebugSessionResultSchema.parse(await debug.startSession(parsed));
      },
    ],
    [BRIDGE_METHODS.listDebugSessions, (params) => ListDebugSessionsResultSchema.parse(debug.listSessions(ListDebugSessionsParamsSchema.parse(params)))],
    [BRIDGE_METHODS.listDebugOutput, (params) => ListDebugOutputResultSchema.parse(debug.listOutput(ListDebugOutputParamsSchema.parse(params)))],
    [BRIDGE_METHODS.readDebugOutput, (params) => ReadDebugOutputResultSchema.parse(debug.readOutput(ReadDebugOutputParamsSchema.parse(params)))],
    [BRIDGE_METHODS.getDebugState, async (params) => GetDebugStateResultSchema.parse(await debug.getState(GetDebugStateParamsSchema.parse(params)))],
    [
      BRIDGE_METHODS.controlDebugSession,
      async (params, context) => {
        const parsed = ControlDebugSessionParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_control_debug_session", title: `Debug ${parsed.action}`, reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return ControlDebugSessionResultSchema.parse(await debug.control(parsed));
          },
        );
      },
    ],
    [BRIDGE_METHODS.listBreakpoints, (params) => ListBreakpointsResultSchema.parse(debug.listBreakpoints(ListBreakpointsParamsSchema.parse(params)))],
    [
      BRIDGE_METHODS.updateBreakpoints,
      async (params, context) => {
        const parsed = UpdateBreakpointsParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_update_breakpoints", title: "Update debug breakpoints", reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return UpdateBreakpointsResultSchema.parse(await debug.updateBreakpoints(parsed));
          },
          (result) => ({ editCount: result.breakpoints.length }),
        );
      },
    ],
    [
      BRIDGE_METHODS.evaluateDebugExpression,
      async (params, context) => {
        const parsed = EvaluateDebugExpressionParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_evaluate_debug_expression", title: "Evaluate debug expression", reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return EvaluateDebugExpressionResultSchema.parse(await debug.evaluate(parsed));
          },
        );
      },
    ],
    [
      BRIDGE_METHODS.setDebugVariable,
      async (params, context) => {
        const parsed = SetDebugVariableParamsSchema.parse(params);
        return activity.track(
          { toolName: "vscode_set_debug_variable", title: "Set debug variable", reason: parsed.reason },
          async () => {
            await ensureSessionWorkspaceEnabled(experiments, onboarding, parsed.sessionId, context.signal);
            assertRequestActive(context.signal);
            return SetDebugVariableResultSchema.parse(await debug.setVariable(parsed));
          },
        );
      },
    ],
  ]);
}
