import { z } from "zod";

import {
  DEFAULT_DEBUG_ITEM_LIMIT,
  DEFAULT_TASK_LIMIT,
  MAX_CONFIGURATION_OPERATIONS,
  MAX_DEBUG_STACK_FRAMES,
  MAX_DEBUG_VARIABLES,
  MAX_EXPERIMENT_RATIONALE_CHARACTERS,
  MAX_TASK_LIMIT,
} from "./constants.js";
import {
  ContentSha256Schema,
  ExperimentIdSchema,
} from "./experiments.js";

const InstanceIdSchema = z.uuid();
const UriSchema = z.string().min(1);
const ReasonSchema = z.string().trim().min(1).max(MAX_EXPERIMENT_RATIONALE_CHARACTERS);
const NullableHashSchema = ContentSha256Schema.nullable();

export const BridgeExecutionModeSchema = z.enum(["explicit", "aggressive"]);
export const WorkspaceConfigurationTargetSchema = z.enum([
  "settings",
  "launch",
  "tasks",
  "workspace",
]);
export const JsonPointerSchema = z
  .string()
  .max(1_024)
  .refine((value) => value === "" || value.startsWith("/"), {
    message: "JSON pointers must be empty or begin with '/'.",
  });
export const ConfigurationOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), path: JsonPointerSchema, value: z.unknown() }).strict(),
  z.object({ operation: z.literal("replace"), path: JsonPointerSchema, value: z.unknown() }).strict(),
  z.object({ operation: z.literal("remove"), path: JsonPointerSchema }).strict(),
]);

export const GetWorkspaceConfigurationParamsSchema = z
  .object({
    rootUri: UriSchema,
    target: WorkspaceConfigurationTargetSchema,
  })
  .strict();
export const GetWorkspaceConfigurationInputSchema =
  GetWorkspaceConfigurationParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const WorkspaceConfigurationResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    rootUri: UriSchema,
    target: WorkspaceConfigurationTargetSchema,
    uri: UriSchema.nullable(),
    exists: z.boolean(),
    content: z.string(),
    contentSha256: NullableHashSchema,
    parseErrors: z.array(z.string().max(500)).max(100),
    deferredEffects: z.boolean(),
    returnedCharacters: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const UpdateWorkspaceConfigurationParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    rootUri: UriSchema,
    target: WorkspaceConfigurationTargetSchema,
    expectedExists: z.boolean(),
    expectedSha256: NullableHashSchema,
    operations: z.array(ConfigurationOperationSchema).min(1).max(MAX_CONFIGURATION_OPERATIONS),
    reason: ReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expectedExists !== (value.expectedSha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["expectedSha256"],
        message: "expectedSha256 must be present exactly when expectedExists is true.",
      });
    }
  });
export const UpdateWorkspaceConfigurationInputSchema =
  UpdateWorkspaceConfigurationParamsSchema.safeExtend({ instanceId: InstanceIdSchema });
export const UpdateWorkspaceConfigurationResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    rootUri: UriSchema,
    target: WorkspaceConfigurationTargetSchema,
    uri: UriSchema,
    created: z.boolean(),
    saved: z.literal(true),
    contentSha256: ContentSha256Schema,
    checkpointId: z.uuid(),
    deferredEffects: z.boolean(),
    updatedAt: z.string().min(1),
  })
  .strict();

export const TaskIdSchema = ContentSha256Schema;
export const TaskExecutionIdSchema = z.uuid();
export const TaskSummarySchema = z
  .object({
    taskId: TaskIdSchema,
    fingerprint: ContentSha256Schema,
    label: z.string().min(1).max(1_000),
    source: z.string().min(1).max(500),
    type: z.string().min(1).max(200),
    group: z.enum(["build", "test", "clean", "rebuild", "none"]),
    scope: z.enum(["folder", "workspace"]),
    rootUri: UriSchema,
    detail: z.string().max(1_000).nullable(),
  })
  .strict();
export const ListTasksParamsSchema = z
  .object({
    rootUri: UriSchema,
    type: z.string().min(1).max(200).optional(),
    group: z.enum(["build", "test", "clean", "rebuild"]).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_TASK_LIMIT).default(DEFAULT_TASK_LIMIT),
  })
  .strict();
export const ListTasksInputSchema = ListTasksParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ListTasksResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    rootUri: UriSchema,
    tasks: z.array(TaskSummarySchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const TaskExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "exited",
  "terminated",
  "unknown",
]);
export const TaskExecutionSchema = z
  .object({
    executionId: TaskExecutionIdSchema,
    taskId: TaskIdSchema,
    taskLabel: z.string().min(1).max(1_000),
    status: TaskExecutionStatusSchema,
    startedAt: z.string().min(1),
    endedAt: z.string().nullable(),
    processId: z.number().int().positive().nullable(),
    exitCode: z.number().int().nullable(),
    terminalId: z.uuid().nullable(),
    terminalExecutionId: z.uuid().nullable(),
    terminalCoverage: z.enum(["complete", "partial", "unavailable"]),
  })
  .strict();
export const RunTaskParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    rootUri: UriSchema,
    taskId: TaskIdSchema,
    expectedFingerprint: ContentSha256Schema,
    reason: ReasonSchema,
  })
  .strict();
export const RunTaskInputSchema = RunTaskParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const RunTaskResultSchema = z
  .object({ instanceId: InstanceIdSchema, sessionId: ExperimentIdSchema, execution: TaskExecutionSchema })
  .strict();
export const ListTaskExecutionsParamsSchema = z
  .object({
    rootUri: UriSchema,
    activeOnly: z.boolean().default(false),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_TASK_LIMIT).default(DEFAULT_TASK_LIMIT),
  })
  .strict();
export const ListTaskExecutionsInputSchema =
  ListTaskExecutionsParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ListTaskExecutionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    rootUri: UriSchema,
    executions: z.array(TaskExecutionSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export const TerminateTaskParamsSchema = z
  .object({ sessionId: ExperimentIdSchema, executionId: TaskExecutionIdSchema, reason: ReasonSchema })
  .strict();
export const TerminateTaskInputSchema =
  TerminateTaskParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const TerminateTaskResultSchema = z
  .object({ instanceId: InstanceIdSchema, sessionId: ExperimentIdSchema, execution: TaskExecutionSchema })
  .strict();

export const DebugSessionIdSchema = z.string().min(1).max(500);
export const DebugConfigurationSummarySchema = z
  .object({
    name: z.string().min(1).max(1_000),
    type: z.string().min(1).max(200).nullable(),
    request: z.enum(["launch", "attach"]).nullable(),
    compound: z.boolean(),
    fingerprint: ContentSha256Schema,
  })
  .strict();
export const ListDebugConfigurationsParamsSchema = z.object({ rootUri: UriSchema }).strict();
export const ListDebugConfigurationsInputSchema =
  ListDebugConfigurationsParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ListDebugConfigurationsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    rootUri: UriSchema,
    configurations: z.array(DebugConfigurationSummarySchema).max(500),
    parseErrors: z.array(z.string().max(500)).max(100),
  })
  .strict();

export const DebugSessionStatusSchema = z.enum(["starting", "running", "stopped", "terminated", "unknown"]);
export const DebugSessionSummarySchema = z
  .object({
    debugSessionId: DebugSessionIdSchema,
    name: z.string().min(1).max(1_000),
    type: z.string().min(1).max(200),
    status: DebugSessionStatusSchema,
    rootUri: UriSchema.nullable(),
    startedAt: z.string().min(1),
    endedAt: z.string().nullable(),
    stoppedReason: z.string().max(500).nullable(),
  })
  .strict();
export const StartDebugSessionParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    rootUri: UriSchema,
    configurationName: z.string().min(1).max(1_000),
    expectedFingerprint: ContentSha256Schema,
    reason: ReasonSchema,
  })
  .strict();
export const StartDebugSessionInputSchema =
  StartDebugSessionParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const StartDebugSessionResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    started: z.literal(true),
    debugSession: DebugSessionSummarySchema.nullable(),
  })
  .strict();
export const ListDebugSessionsParamsSchema = z
  .object({ rootUri: UriSchema, includeTerminated: z.boolean().default(true) })
  .strict();
export const ListDebugSessionsInputSchema =
  ListDebugSessionsParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ListDebugSessionsResultSchema = z
  .object({ instanceId: InstanceIdSchema, rootUri: UriSchema, sessions: z.array(DebugSessionSummarySchema).max(200) })
  .strict();

export const DebugStateQuerySchema = z.enum(["threads", "stackTrace", "scopes", "variables"]);
export const GetDebugStateParamsSchema = z
  .object({
    debugSessionId: DebugSessionIdSchema,
    query: DebugStateQuerySchema,
    threadId: z.number().int().nonnegative().optional(),
    frameId: z.number().int().nonnegative().optional(),
    variablesReference: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_DEBUG_VARIABLES).default(DEFAULT_DEBUG_ITEM_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    const required = value.query === "stackTrace" ? "threadId" : value.query === "scopes" ? "frameId" : value.query === "variables" ? "variablesReference" : null;
    if (required && value[required] === undefined) {
      context.addIssue({ code: "custom", path: [required], message: `${required} is required for ${value.query}.` });
    }
    if (value.query === "stackTrace" && value.limit > MAX_DEBUG_STACK_FRAMES) {
      context.addIssue({ code: "custom", path: ["limit"], message: "Stack trace pages are limited to 200 frames." });
    }
  });
export const GetDebugStateInputSchema = GetDebugStateParamsSchema.safeExtend({ instanceId: InstanceIdSchema });
export const DebugThreadSchema = z.object({ id: z.number().int().nonnegative(), name: z.string() }).strict();
export const DebugStackFrameSchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    sourceUri: UriSchema.nullable(),
    line: z.number().int().nonnegative().nullable(),
    character: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const DebugScopeSchema = z
  .object({ name: z.string(), variablesReference: z.number().int().nonnegative(), expensive: z.boolean() })
  .strict();
export const DebugVariableSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    type: z.string().nullable(),
    evaluateName: z.string().nullable(),
    variablesReference: z.number().int().nonnegative(),
    namedVariables: z.number().int().nonnegative().nullable(),
    indexedVariables: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const GetDebugStateResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    debugSessionId: DebugSessionIdSchema,
    query: DebugStateQuerySchema,
    threads: z.array(DebugThreadSchema),
    stackFrames: z.array(DebugStackFrameSchema),
    scopes: z.array(DebugScopeSchema),
    variables: z.array(DebugVariableSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const DebugControlActionSchema = z.enum(["pause", "continue", "next", "stepIn", "stepOut", "restart", "terminate"]);
export const ControlDebugSessionParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    debugSessionId: DebugSessionIdSchema,
    action: DebugControlActionSchema,
    threadId: z.number().int().nonnegative().optional(),
    singleThread: z.boolean().optional(),
    reason: ReasonSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!["restart", "terminate"].includes(value.action) && value.threadId === undefined) {
      context.addIssue({ code: "custom", path: ["threadId"], message: "threadId is required for this debug action." });
    }
  });
export const ControlDebugSessionInputSchema =
  ControlDebugSessionParamsSchema.safeExtend({ instanceId: InstanceIdSchema });
export const ControlDebugSessionResultSchema = z
  .object({ instanceId: InstanceIdSchema, sessionId: ExperimentIdSchema, debugSessionId: DebugSessionIdSchema, action: DebugControlActionSchema, accepted: z.literal(true) })
  .strict();

export const SourceBreakpointSpecSchema = z
  .object({
    kind: z.literal("source"),
    uri: UriSchema,
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative().default(0),
    enabled: z.boolean().default(true),
    condition: z.string().max(2_000).nullable().default(null),
    hitCondition: z.string().max(2_000).nullable().default(null),
    logMessage: z.string().max(4_000).nullable().default(null),
  })
  .strict();
export const FunctionBreakpointSpecSchema = z
  .object({
    kind: z.literal("function"),
    functionName: z.string().min(1).max(2_000),
    enabled: z.boolean().default(true),
    condition: z.string().max(2_000).nullable().default(null),
    hitCondition: z.string().max(2_000).nullable().default(null),
    logMessage: z.string().max(4_000).nullable().default(null),
  })
  .strict();
export const BreakpointSpecSchema = z.discriminatedUnion("kind", [SourceBreakpointSpecSchema, FunctionBreakpointSpecSchema]);
export const BreakpointSummarySchema = z
  .object({ id: z.string().min(1), verified: z.boolean().nullable(), spec: BreakpointSpecSchema })
  .strict();
export const ListBreakpointsParamsSchema = z.object({ rootUri: UriSchema }).strict();
export const ListBreakpointsInputSchema = ListBreakpointsParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ListBreakpointsResultSchema = z
  .object({ instanceId: InstanceIdSchema, rootUri: UriSchema, revision: ContentSha256Schema, breakpoints: z.array(BreakpointSummarySchema).max(500) })
  .strict();
export const UpdateBreakpointsParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    rootUri: UriSchema,
    expectedRevision: ContentSha256Schema,
    breakpoints: z.array(BreakpointSpecSchema).max(500),
    reason: ReasonSchema,
  })
  .strict();
export const UpdateBreakpointsInputSchema = UpdateBreakpointsParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const UpdateBreakpointsResultSchema = z
  .object({ instanceId: InstanceIdSchema, sessionId: ExperimentIdSchema, rootUri: UriSchema, revision: ContentSha256Schema, breakpoints: z.array(BreakpointSummarySchema).max(500) })
  .strict();

export const EvaluateDebugExpressionParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    debugSessionId: DebugSessionIdSchema,
    frameId: z.number().int().nonnegative().optional(),
    context: z.enum(["repl", "watch", "hover"]),
    expression: z.string().min(1).max(100_000),
    reason: ReasonSchema,
  })
  .strict();
export const EvaluateDebugExpressionInputSchema =
  EvaluateDebugExpressionParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const EvaluateDebugExpressionResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    debugSessionId: DebugSessionIdSchema,
    result: z.string(),
    type: z.string().nullable(),
    variablesReference: z.number().int().nonnegative(),
    namedVariables: z.number().int().nonnegative().nullable(),
    indexedVariables: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const SetDebugVariableParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    debugSessionId: DebugSessionIdSchema,
    variablesReference: z.number().int().nonnegative(),
    name: z.string().min(1).max(10_000),
    value: z.string().max(100_000),
    reason: ReasonSchema,
  })
  .strict();
export const SetDebugVariableInputSchema =
  SetDebugVariableParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const SetDebugVariableResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    debugSessionId: DebugSessionIdSchema,
    value: z.string(),
    type: z.string().nullable(),
    variablesReference: z.number().int().nonnegative(),
  })
  .strict();

export type BridgeExecutionMode = z.infer<typeof BridgeExecutionModeSchema>;
export type WorkspaceConfigurationTarget = z.infer<typeof WorkspaceConfigurationTargetSchema>;
export type ConfigurationOperation = z.infer<typeof ConfigurationOperationSchema>;
export type GetWorkspaceConfigurationParams = z.infer<typeof GetWorkspaceConfigurationParamsSchema>;
export type WorkspaceConfigurationResult = z.infer<typeof WorkspaceConfigurationResultSchema>;
export type UpdateWorkspaceConfigurationParams = z.infer<typeof UpdateWorkspaceConfigurationParamsSchema>;
export type UpdateWorkspaceConfigurationResult = z.infer<typeof UpdateWorkspaceConfigurationResultSchema>;
export type ListTasksParams = z.infer<typeof ListTasksParamsSchema>;
export type ListTasksResult = z.infer<typeof ListTasksResultSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskExecution = z.infer<typeof TaskExecutionSchema>;
export type RunTaskParams = z.infer<typeof RunTaskParamsSchema>;
export type RunTaskResult = z.infer<typeof RunTaskResultSchema>;
export type ListTaskExecutionsParams = z.infer<typeof ListTaskExecutionsParamsSchema>;
export type ListTaskExecutionsResult = z.infer<typeof ListTaskExecutionsResultSchema>;
export type TerminateTaskParams = z.infer<typeof TerminateTaskParamsSchema>;
export type TerminateTaskResult = z.infer<typeof TerminateTaskResultSchema>;
export type ListDebugConfigurationsParams = z.infer<typeof ListDebugConfigurationsParamsSchema>;
export type ListDebugConfigurationsResult = z.infer<typeof ListDebugConfigurationsResultSchema>;
export type DebugConfigurationSummary = z.infer<typeof DebugConfigurationSummarySchema>;
export type DebugSessionSummary = z.infer<typeof DebugSessionSummarySchema>;
export type StartDebugSessionParams = z.infer<typeof StartDebugSessionParamsSchema>;
export type StartDebugSessionResult = z.infer<typeof StartDebugSessionResultSchema>;
export type ListDebugSessionsParams = z.infer<typeof ListDebugSessionsParamsSchema>;
export type ListDebugSessionsResult = z.infer<typeof ListDebugSessionsResultSchema>;
export type GetDebugStateParams = z.infer<typeof GetDebugStateParamsSchema>;
export type GetDebugStateResult = z.infer<typeof GetDebugStateResultSchema>;
export type ControlDebugSessionParams = z.infer<typeof ControlDebugSessionParamsSchema>;
export type ControlDebugSessionResult = z.infer<typeof ControlDebugSessionResultSchema>;
export type BreakpointSpec = z.infer<typeof BreakpointSpecSchema>;
export type BreakpointSummary = z.infer<typeof BreakpointSummarySchema>;
export type ListBreakpointsParams = z.infer<typeof ListBreakpointsParamsSchema>;
export type ListBreakpointsResult = z.infer<typeof ListBreakpointsResultSchema>;
export type UpdateBreakpointsParams = z.infer<typeof UpdateBreakpointsParamsSchema>;
export type UpdateBreakpointsResult = z.infer<typeof UpdateBreakpointsResultSchema>;
export type EvaluateDebugExpressionParams = z.infer<typeof EvaluateDebugExpressionParamsSchema>;
export type EvaluateDebugExpressionResult = z.infer<typeof EvaluateDebugExpressionResultSchema>;
export type SetDebugVariableParams = z.infer<typeof SetDebugVariableParamsSchema>;
export type SetDebugVariableResult = z.infer<typeof SetDebugVariableResultSchema>;
