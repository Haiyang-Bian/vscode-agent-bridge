import { z } from "zod";

import {
  CODE_ACTION_TTL_MS,
  MAX_EXPERIMENT_RATIONALE_CHARACTERS,
} from "./constants.js";
import {
  CheckpointIdSchema,
  ContentSha256Schema,
  ExperimentIdSchema,
} from "./experiments.js";
import { DiagnosticItemSchema, RangeSchema } from "./schemas.js";

export const AutonomyProfileSchema = z.enum(["autonomous", "review", "readOnly"]);
export const TerminalReadPolicySchema = z.enum(["allow", "metadataOnly", "deny"]);

const InstanceIdSchema = z.uuid();
const UriSchema = z.string().min(1);
const ReasonSchema = z.string().min(1).max(MAX_EXPERIMENT_RATIONALE_CHARACTERS);
const ExpectedDocumentSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    uri: UriSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedSha256: ContentSha256Schema,
    reason: ReasonSchema,
  })
  .strict();

export const SaveDocumentParamsSchema = ExpectedDocumentSchema;
export const SaveDocumentInputSchema = SaveDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const SaveDocumentResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    uri: UriSchema,
    saved: z.literal(true),
    documentVersion: z.number().int().nonnegative(),
    contentSha256: ContentSha256Schema,
    isDirty: z.boolean(),
    checkpointId: CheckpointIdSchema,
    savedAt: z.string().min(1),
    saveEffectsChangedContent: z.boolean(),
  })
  .strict();

export const FormatDocumentParamsSchema = ExpectedDocumentSchema;
export const FormatDocumentInputSchema = FormatDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const FormatDocumentResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    uri: UriSchema,
    applied: z.boolean(),
    documentVersion: z.number().int().nonnegative(),
    contentSha256: ContentSha256Schema,
    isDirty: z.boolean(),
    editCount: z.number().int().nonnegative(),
    checkpointId: CheckpointIdSchema.nullable(),
  })
  .strict();

export const CodeActionIdSchema = z.uuid();
export const ListCodeActionsParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    uri: UriSchema,
    range: RangeSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedSha256: ContentSha256Schema,
    kinds: z.array(z.string().min(1)).max(32).optional(),
  })
  .strict();
export const ListCodeActionsInputSchema = ListCodeActionsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const CodeActionSummarySchema = z
  .object({
    actionId: CodeActionIdSchema,
    title: z.string().min(1),
    kind: z.string().nullable(),
    diagnostics: z.array(DiagnosticItemSchema),
    applicable: z.boolean(),
    unsupportedReason: z.string().nullable(),
    expiresAt: z.string().min(1),
  })
  .strict();
export const ListCodeActionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    uri: UriSchema,
    actions: z.array(CodeActionSummarySchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    ttlMs: z.literal(CODE_ACTION_TTL_MS),
  })
  .strict();

export const ApplyCodeActionParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    actionId: CodeActionIdSchema,
    reason: ReasonSchema,
  })
  .strict();
export const ApplyCodeActionInputSchema = ApplyCodeActionParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ApplyCodeActionResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: ExperimentIdSchema,
    actionId: CodeActionIdSchema,
    checkpointId: CheckpointIdSchema,
    appliedAt: z.string().min(1),
    documents: z.array(
      z
        .object({
          uri: UriSchema,
          documentVersion: z.number().int().nonnegative(),
          contentSha256: ContentSha256Schema,
          isDirty: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type ApplyCodeActionParams = z.infer<typeof ApplyCodeActionParamsSchema>;
export type ApplyCodeActionResult = z.infer<typeof ApplyCodeActionResultSchema>;
export type AutonomyProfile = z.infer<typeof AutonomyProfileSchema>;
export type FormatDocumentParams = z.infer<typeof FormatDocumentParamsSchema>;
export type FormatDocumentResult = z.infer<typeof FormatDocumentResultSchema>;
export type ListCodeActionsParams = z.infer<typeof ListCodeActionsParamsSchema>;
export type ListCodeActionsResult = z.infer<typeof ListCodeActionsResultSchema>;
export type SaveDocumentParams = z.infer<typeof SaveDocumentParamsSchema>;
export type SaveDocumentResult = z.infer<typeof SaveDocumentResultSchema>;
export type TerminalReadPolicy = z.infer<typeof TerminalReadPolicySchema>;
