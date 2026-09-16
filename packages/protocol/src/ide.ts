import { z } from "zod";

import {
  CODE_ACTION_TTL_MS,
  DEFAULT_RESULT_LIMIT,
  MAX_OPERATION_REASON_CHARACTERS,
  MAX_RESULT_LIMIT,
} from "./constants.js";
import {
  ContentSha256Schema,
} from "./changes.js";
import { DiagnosticItemSchema, RangeSchema } from "./schemas.js";

export const AutonomyProfileSchema = z.enum(["autonomous", "review", "readOnly"]);
export const TerminalReadPolicySchema = z.enum(["allow", "metadataOnly", "deny"]);

const InstanceIdSchema = z.uuid();
const UriSchema = z.string().min(1);
const ReasonSchema = z.string().min(1).max(MAX_OPERATION_REASON_CHARACTERS);
const ExpectedDocumentSchema = z
  .object({
    uri: UriSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedSha256: ContentSha256Schema,
    reason: ReasonSchema.optional(),
  })
  .strict();

export const SaveDocumentParamsSchema = ExpectedDocumentSchema.safeExtend({
  rootUri: UriSchema,
});
export const SaveDocumentInputSchema = SaveDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const SaveDocumentResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    saved: z.literal(true),
    documentVersion: z.number().int().nonnegative(),
    contentSha256: ContentSha256Schema,
    isDirty: z.boolean(),
    savedAt: z.string().min(1),
    saveEffectsChangedContent: z.boolean(),
  })
  .strict();

export const FormatDocumentParamsSchema = ExpectedDocumentSchema.safeExtend({
  rootUri: UriSchema,
});
export const FormatDocumentInputSchema = FormatDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const FormatDocumentResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    applied: z.boolean(),
    documentVersion: z.number().int().nonnegative(),
    contentSha256: ContentSha256Schema,
    isDirty: z.boolean(),
    editCount: z.number().int().nonnegative(),
  })
  .strict();

export const CodeActionIdSchema = z.uuid();
export const ListCodeActionsParamsSchema = z
  .object({
    rootUri: UriSchema,
    uri: UriSchema,
    range: RangeSchema,
    expectedVersion: z.number().int().nonnegative(),
    expectedSha256: ContentSha256Schema,
    kinds: z.array(z.string().min(1)).max(32).optional(),
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();
export const ListCodeActionsInputSchema = ListCodeActionsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const CodeActionSummarySchema = z
  .object({
    actionId: CodeActionIdSchema,
    title: z.string().min(1).max(1_000),
    kind: z.string().nullable(),
    diagnostics: z.array(DiagnosticItemSchema).max(50),
    applicable: z.boolean(),
    unsupportedReason: z.string().nullable(),
    expiresAt: z.string().min(1),
  })
  .strict();
export const ListCodeActionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
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
    actionId: CodeActionIdSchema,
    reason: ReasonSchema.optional(),
  })
  .strict();
export const ApplyCodeActionInputSchema = ApplyCodeActionParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ApplyCodeActionResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    actionId: CodeActionIdSchema,
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
