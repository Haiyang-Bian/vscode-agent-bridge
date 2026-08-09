import { z } from "zod";

import {
  DEFAULT_TERMINAL_EXECUTION_LIMIT,
  DEFAULT_TERMINAL_OUTPUT_CHARACTERS,
  MAX_TERMINAL_EXECUTION_LIMIT,
  MAX_TERMINAL_OUTPUT_CHARACTERS,
} from "./constants.js";

const InstanceIdSchema = z.uuid();
export const TerminalIdSchema = z.uuid();
export const TerminalExecutionIdSchema = z.uuid();
export const TerminalStatusSchema = z.enum(["idle", "running", "exited", "unknown"]);
export const TerminalLifecycleSchema = z.enum(["open", "closed"]);
export const TerminalShellIntegrationSchema = z.enum(["available", "unavailable"]);
export const TerminalCommandConfidenceSchema = z.enum(["low", "medium", "high", "unknown"]);
export const TerminalSensitiveFieldCoverageSchema = z.enum([
  "captured",
  "unavailable",
  "redacted",
]);
export const TerminalOutputCoverageSchema = z.enum([
  "capturing",
  "complete",
  "partial-prefix-missing",
  "partial-dropped",
  "unavailable",
  "redacted",
]);

export const TerminalCoverageSchema = z
  .object({
    metadata: z.literal("complete"),
    commandLine: TerminalSensitiveFieldCoverageSchema,
    cwd: TerminalSensitiveFieldCoverageSchema,
    output: TerminalOutputCoverageSchema,
  })
  .strict();

export const ListTerminalsParamsSchema = z.object({}).strict();
export const ListTerminalsInputSchema = ListTerminalsParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();
export const TerminalInfoSchema = z
  .object({
    terminalId: TerminalIdSchema,
    name: z.string(),
    processId: z.number().int().positive().nullable(),
    isActive: z.boolean(),
    lifecycle: TerminalLifecycleSchema,
    status: TerminalStatusSchema,
    shellIntegration: TerminalShellIntegrationSchema,
    exitCode: z.number().int().nullable(),
    openedAt: z.string().min(1),
    closedAt: z.string().min(1).nullable(),
    cwd: z.string().nullable(),
    coverage: TerminalCoverageSchema,
  })
  .strict();
export const ListTerminalsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    terminals: z.array(TerminalInfoSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const ListTerminalExecutionsParamsSchema = z
  .object({
    terminalId: TerminalIdSchema.optional(),
    cursor: z.string().min(1).optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_TERMINAL_EXECUTION_LIMIT)
      .default(DEFAULT_TERMINAL_EXECUTION_LIMIT),
  })
  .strict();
export const ListTerminalExecutionsInputSchema = ListTerminalExecutionsParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();
export const TerminalExecutionInfoSchema = z
  .object({
    executionId: TerminalExecutionIdSchema,
    terminalId: TerminalIdSchema,
    commandLine: z.string().nullable(),
    commandConfidence: TerminalCommandConfidenceSchema,
    commandLineTrusted: z.boolean(),
    cwd: z.string().nullable(),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
    status: TerminalStatusSchema,
    exitCode: z.number().int().nullable(),
    capturedCharacters: z.number().int().nonnegative(),
    droppedCharacters: z.number().int().nonnegative(),
    outputAvailable: z.boolean(),
    coverage: TerminalCoverageSchema,
  })
  .strict();
export const ListTerminalExecutionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    executions: z.array(TerminalExecutionInfoSchema),
    returnedCount: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const ReadTerminalOutputParamsSchema = z
  .object({
    executionId: TerminalExecutionIdSchema,
    cursor: z.number().int().nonnegative().default(0),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(MAX_TERMINAL_OUTPUT_CHARACTERS)
      .default(DEFAULT_TERMINAL_OUTPUT_CHARACTERS),
  })
  .strict();
export const ReadTerminalOutputInputSchema = ReadTerminalOutputParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();
export const ReadTerminalOutputResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    executionId: TerminalExecutionIdSchema,
    terminalId: TerminalIdSchema,
    cursor: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative().nullable(),
    text: z.string(),
    returnedCharacters: z.number().int().nonnegative(),
    capturedCharacters: z.number().int().nonnegative(),
    droppedCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
    complete: z.boolean(),
    coverage: TerminalOutputCoverageSchema,
  })
  .strict();

export type ListTerminalExecutionsParams = z.infer<typeof ListTerminalExecutionsParamsSchema>;
export type ListTerminalExecutionsResult = z.infer<typeof ListTerminalExecutionsResultSchema>;
export type ListTerminalsResult = z.infer<typeof ListTerminalsResultSchema>;
export type ReadTerminalOutputParams = z.infer<typeof ReadTerminalOutputParamsSchema>;
export type ReadTerminalOutputResult = z.infer<typeof ReadTerminalOutputResultSchema>;
export type TerminalExecutionInfo = z.infer<typeof TerminalExecutionInfoSchema>;
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;
export type TerminalOutputCoverage = z.infer<typeof TerminalOutputCoverageSchema>;
