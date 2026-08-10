import { z } from "zod";

import {
  DEFAULT_CHECKPOINT_LIMIT,
  MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS,
  MAX_CHANGE_SET_DOCUMENTS,
  MAX_CHANGE_SET_EDITS,
  MAX_CHANGE_SET_REPLACEMENT_CHARACTERS,
  MAX_CHECKPOINT_LIMIT,
  MAX_EXPERIMENT_EVIDENCE_CHARACTERS,
  MAX_EXPERIMENT_RATIONALE_CHARACTERS,
  MAX_EXPERIMENT_TITLE_CHARACTERS,
} from "./constants.js";
import { PositionSchema, RangeSchema } from "./schemas.js";

export const ContentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
export const ExperimentIdSchema = z.uuid();
export const ChangeSetIdSchema = z.uuid();
export const CheckpointIdSchema = z.uuid();

export const ExperimentModeSchema = z.enum(["workspace", "worktree"]);
export const ExperimentLifecycleSchema = z.enum(["active", "finalized", "abandoned"]);
export const ExperimentHealthSchema = z.enum(["complete", "partial", "corrupt"]);
export const ManagedExperimentStateSchema = z.enum([
  "ready",
  "sync-conflicted",
  "promotion-recovery-required",
]);
export const ManagedExperimentInfoSchema = z
  .object({
    targetBranch: z.string().min(1),
    baseHead: GitObjectIdSchema,
    experimentBranch: z.string().min(1),
    experimentHead: GitObjectIdSchema,
    acceptedCommit: GitObjectIdSchema.nullable(),
    formalCommit: GitObjectIdSchema.nullable(),
    state: ManagedExperimentStateSchema,
  })
  .strict();
export const ExperimentCheckpointSourceSchema = z.enum([
  "baseline",
  "agentApply",
  "manualEdit",
  "save",
  "externalChange",
  "gitCommit",
  "restore",
  "explicit",
]);
export const ExperimentEvidenceKindSchema = z.enum([
  "diagnostics",
  "test",
  "build",
  "lint",
  "manual",
  "other",
]);
export const ExperimentEvidenceStatusSchema = z.enum([
  "passed",
  "failed",
  "not-run",
  "unknown",
]);
export const ExperimentEvidenceSourceSchema = z.enum([
  "automatic-diagnostics",
  "client-reported",
  "user-confirmed",
]);

export const ExperimentEvidenceSchema = z
  .object({
    evidenceId: z.uuid(),
    kind: ExperimentEvidenceKindSchema,
    status: ExperimentEvidenceStatusSchema,
    source: ExperimentEvidenceSourceSchema,
    summary: z.string().min(1).max(MAX_EXPERIMENT_EVIDENCE_CHARACTERS),
    createdAt: z.string().min(1),
  })
  .strict();

export const ExperimentCheckpointSchema = z
  .object({
    checkpointId: CheckpointIdSchema,
    parentCheckpointId: CheckpointIdSchema.nullable(),
    sequence: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    source: ExperimentCheckpointSourceSchema,
    summary: z.string().min(1).max(MAX_EXPERIMENT_RATIONALE_CHARACTERS),
    documentCount: z.number().int().nonnegative(),
    coverageComplete: z.boolean(),
    gitCommit: GitObjectIdSchema.nullable(),
    evidence: z.array(ExperimentEvidenceSchema),
  })
  .strict();

export const ExperimentInfoSchema = z
  .object({
    instanceId: z.uuid(),
    sessionId: ExperimentIdSchema,
    mode: ExperimentModeSchema,
    lifecycle: ExperimentLifecycleSchema,
    health: ExperimentHealthSchema,
    title: z.string().min(1).max(MAX_EXPERIMENT_TITLE_CHARACTERS),
    rootUri: z.string().min(1),
    baseRevision: GitObjectIdSchema.nullable(),
    branch: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    currentCheckpointId: CheckpointIdSchema.nullable(),
    acceptedCheckpointId: CheckpointIdSchema.nullable(),
    pinned: z.boolean(),
    storageBytes: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    managed: ManagedExperimentInfoSchema.nullable(),
  })
  .strict();

export const GetExperimentParamsSchema = z.object({}).strict();
export const GetExperimentInputSchema = GetExperimentParamsSchema.extend({
  instanceId: z.uuid().optional(),
}).strict();

const AgentExperimentTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS)
  .refine((value) => !/[\r\n\u0000-\u001f\u007f]/u.test(value), {
    message: "Experiment titles cannot contain control characters.",
  });
const AgentExperimentReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_EXPERIMENT_RATIONALE_CHARACTERS);

export const ListExperimentsParamsSchema = z
  .object({
    rootUri: z.string().min(1).optional(),
    mode: ExperimentModeSchema.optional(),
    lifecycle: ExperimentLifecycleSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_CHECKPOINT_LIMIT).default(DEFAULT_CHECKPOINT_LIMIT),
  })
  .strict();
export const ListExperimentsInputSchema = ListExperimentsParamsSchema.extend({
  instanceId: z.uuid().optional(),
}).strict();
export const ExperimentsResultSchema = z
  .object({
    instanceId: z.uuid(),
    rootUri: z.string().min(1),
    activeSessionId: ExperimentIdSchema.nullable(),
    experiments: z.array(ExperimentInfoSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const StartExperimentParamsSchema = z
  .object({
    rootUri: z.string().min(1),
    title: AgentExperimentTitleSchema,
    reason: AgentExperimentReasonSchema,
  })
  .strict();
export const StartExperimentInputSchema = StartExperimentParamsSchema.extend({
  instanceId: z.uuid(),
}).strict();

export const RenameExperimentParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    expectedTitle: z.string().min(1).max(MAX_EXPERIMENT_TITLE_CHARACTERS),
    title: AgentExperimentTitleSchema,
    reason: AgentExperimentReasonSchema,
  })
  .strict();
export const RenameExperimentInputSchema = RenameExperimentParamsSchema.extend({
  instanceId: z.uuid(),
}).strict();

export const CreateExperimentCheckpointParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    title: AgentExperimentTitleSchema,
    reason: AgentExperimentReasonSchema,
  })
  .strict();
export const CreateExperimentCheckpointInputSchema =
  CreateExperimentCheckpointParamsSchema.extend({ instanceId: z.uuid() }).strict();
export const CreateExperimentCheckpointResultSchema = z
  .object({
    instanceId: z.uuid(),
    sessionId: ExperimentIdSchema,
    checkpoint: ExperimentCheckpointSchema,
  })
  .strict();

export const ListExperimentCheckpointsParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_CHECKPOINT_LIMIT).default(DEFAULT_CHECKPOINT_LIMIT),
  })
  .strict();
export const ListExperimentCheckpointsInputSchema =
  ListExperimentCheckpointsParamsSchema.extend({
    instanceId: z.uuid().optional(),
  }).strict();
export const ExperimentCheckpointsResultSchema = z
  .object({
    instanceId: z.uuid(),
    sessionId: ExperimentIdSchema,
    checkpoints: z.array(ExperimentCheckpointSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const TextReplacementSchema = z
  .object({
    range: RangeSchema,
    newText: z.string().max(MAX_CHANGE_SET_REPLACEMENT_CHARACTERS),
  })
  .strict();
export const PreparedTextDocumentInputSchema = z
  .object({
    uri: z.string().min(1),
    expectedSha256: ContentSha256Schema,
    expectedVersion: z.number().int().nonnegative().optional(),
    edits: z.array(TextReplacementSchema).min(1).max(MAX_CHANGE_SET_EDITS),
  })
  .strict();

export const PrepareTextEditsParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    title: z.string().min(1).max(MAX_EXPERIMENT_TITLE_CHARACTERS),
    rationale: z.string().max(MAX_EXPERIMENT_RATIONALE_CHARACTERS).optional(),
    documents: z
      .array(PreparedTextDocumentInputSchema)
      .min(1)
      .max(MAX_CHANGE_SET_DOCUMENTS),
  })
  .strict()
  .superRefine((value, context) => {
    const uris = new Set<string>();
    let editCount = 0;
    let replacementCharacters = 0;
    for (const [documentIndex, document] of value.documents.entries()) {
      if (uris.has(document.uri)) {
        context.addIssue({
          code: "custom",
          message: "Document URIs must be unique within a change set.",
          path: ["documents", documentIndex, "uri"],
        });
      }
      uris.add(document.uri);
      editCount += document.edits.length;
      replacementCharacters += document.edits.reduce(
        (total, edit) => total + edit.newText.length,
        0,
      );

      const sorted = [...document.edits].sort((left, right) =>
        comparePositions(left.range.start, right.range.start),
      );
      for (let index = 1; index < sorted.length; index += 1) {
        if (comparePositions(sorted[index - 1]!.range.end, sorted[index]!.range.start) > 0) {
          context.addIssue({
            code: "custom",
            message: "Text edit ranges must not overlap.",
            path: ["documents", documentIndex, "edits"],
          });
          break;
        }
      }
    }
    if (editCount > MAX_CHANGE_SET_EDITS) {
      context.addIssue({ code: "custom", message: "Change set contains too many edits." });
    }
    if (replacementCharacters > MAX_CHANGE_SET_REPLACEMENT_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: "Change set replacement text exceeds the character limit.",
      });
    }
  });
export const PrepareTextEditsInputSchema = PrepareTextEditsParamsSchema.safeExtend({
  instanceId: z.uuid(),
});

export const PrepareRenameParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    title: z.string().min(1).max(MAX_EXPERIMENT_TITLE_CHARACTERS),
    rationale: z.string().max(MAX_EXPERIMENT_RATIONALE_CHARACTERS).optional(),
    uri: z.string().min(1),
    position: PositionSchema,
    newName: z.string().min(1).max(256),
    expectedSha256: ContentSha256Schema,
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export const PrepareRenameInputSchema = PrepareRenameParamsSchema.extend({
  instanceId: z.uuid(),
}).strict();

export const PreparedDocumentChangeSchema = z
  .object({
    uri: z.string().min(1),
    beforeSha256: ContentSha256Schema,
    beforeVersion: z.number().int().nonnegative(),
    afterSha256: ContentSha256Schema,
    edits: z.array(TextReplacementSchema),
    editCount: z.number().int().positive(),
    replacementCharacters: z.number().int().nonnegative(),
  })
  .strict();
export const PreparedChangeSetSchema = z
  .object({
    instanceId: z.uuid(),
    sessionId: ExperimentIdSchema,
    changeSetId: ChangeSetIdSchema,
    kind: z.enum(["text-edits", "rename"]),
    title: z.string().min(1).max(MAX_EXPERIMENT_TITLE_CHARACTERS),
    rationale: z.string().nullable(),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
    documents: z.array(PreparedDocumentChangeSchema),
    editCount: z.number().int().positive(),
    replacementCharacters: z.number().int().nonnegative(),
  })
  .strict();

export const ApplyChangeSetParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    changeSetId: ChangeSetIdSchema,
  })
  .strict();
export const ApplyChangeSetInputSchema = ApplyChangeSetParamsSchema.extend({
  instanceId: z.uuid(),
}).strict();
export const AppliedDocumentSchema = z
  .object({
    uri: z.string().min(1),
    documentVersion: z.number().int().nonnegative(),
    contentSha256: ContentSha256Schema,
    isDirty: z.boolean(),
  })
  .strict();
export const AppliedChangeSetSchema = z
  .object({
    instanceId: z.uuid(),
    sessionId: ExperimentIdSchema,
    changeSetId: ChangeSetIdSchema,
    checkpointId: CheckpointIdSchema,
    appliedAt: z.string().min(1),
    documents: z.array(AppliedDocumentSchema),
  })
  .strict();

export const RecordExperimentEvidenceParamsSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    checkpointId: CheckpointIdSchema,
    kind: ExperimentEvidenceKindSchema.exclude(["diagnostics", "manual"]),
    status: ExperimentEvidenceStatusSchema,
    summary: z.string().min(1).max(MAX_EXPERIMENT_EVIDENCE_CHARACTERS),
  })
  .strict();
export const RecordExperimentEvidenceInputSchema =
  RecordExperimentEvidenceParamsSchema.extend({
    instanceId: z.uuid(),
  }).strict();

export type AppliedChangeSet = z.infer<typeof AppliedChangeSetSchema>;
export type ApplyChangeSetParams = z.infer<typeof ApplyChangeSetParamsSchema>;
export type ExperimentCheckpoint = z.infer<typeof ExperimentCheckpointSchema>;
export type ExperimentCheckpointsResult = z.infer<typeof ExperimentCheckpointsResultSchema>;
export type ExperimentEvidence = z.infer<typeof ExperimentEvidenceSchema>;
export type ExperimentInfo = z.infer<typeof ExperimentInfoSchema>;
export type ExperimentsResult = z.infer<typeof ExperimentsResultSchema>;
export type ListExperimentsParams = z.infer<typeof ListExperimentsParamsSchema>;
export type StartExperimentParams = z.infer<typeof StartExperimentParamsSchema>;
export type RenameExperimentParams = z.infer<typeof RenameExperimentParamsSchema>;
export type CreateExperimentCheckpointParams = z.infer<
  typeof CreateExperimentCheckpointParamsSchema
>;
export type ListExperimentCheckpointsParams = z.infer<
  typeof ListExperimentCheckpointsParamsSchema
>;
export type ManagedExperimentInfo = z.infer<typeof ManagedExperimentInfoSchema>;
export type PreparedChangeSet = z.infer<typeof PreparedChangeSetSchema>;
export type PreparedDocumentChange = z.infer<typeof PreparedDocumentChangeSchema>;
export type PrepareRenameParams = z.infer<typeof PrepareRenameParamsSchema>;
export type PrepareTextEditsParams = z.infer<typeof PrepareTextEditsParamsSchema>;
export type RecordExperimentEvidenceParams = z.infer<
  typeof RecordExperimentEvidenceParamsSchema
>;
export type TextReplacement = z.infer<typeof TextReplacementSchema>;

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}
