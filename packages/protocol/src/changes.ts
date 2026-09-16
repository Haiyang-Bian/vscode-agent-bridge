import { z } from "zod";

import {
  MAX_CHANGE_SET_DOCUMENTS,
  MAX_CHANGE_SET_EDITS,
  MAX_CHANGE_SET_REPLACEMENT_CHARACTERS,
  MAX_RESOURCE_CHANGE_CHARACTERS,
  MAX_RESOURCE_OPERATIONS,
} from "./constants.js";
import { PositionSchema, RangeSchema } from "./schemas.js";

export const ContentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const ChangeSetIdSchema = z.uuid();

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
    rootUri: z.string().min(1),
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
    rootUri: z.string().min(1),
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

export const ResourceKindSchema = z.enum(["file", "directory"]);
export const ResourceChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      uri: z.string().min(1),
      kind: ResourceKindSchema,
      content: z.string().max(MAX_RESOURCE_CHANGE_CHARACTERS).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.kind === "file" && value.content === undefined) {
        context.addIssue({ code: "custom", path: ["content"], message: "Text file creation requires content." });
      }
      if (value.kind === "directory" && value.content !== undefined) {
        context.addIssue({ code: "custom", path: ["content"], message: "Directories cannot have text content." });
      }
    }),
  z
    .object({
      operation: z.literal("rename"),
      uri: z.string().min(1),
      targetUri: z.string().min(1),
      kind: ResourceKindSchema,
      expectedSha256: ContentSha256Schema.nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      uri: z.string().min(1),
      kind: ResourceKindSchema,
      expectedSha256: ContentSha256Schema.nullable(),
      recursive: z.boolean().default(false),
    })
    .strict(),
]);
export const PrepareResourceChangesParamsSchema = z
  .object({
    rootUri: z.string().min(1),
    operations: z.array(ResourceChangeSchema).min(1).max(MAX_RESOURCE_OPERATIONS),
  })
  .strict()
  .superRefine((value, context) => {
    const targets = new Set<string>();
    let characters = 0;
    for (const [index, operation] of value.operations.entries()) {
      if (targets.has(operation.uri)) {
        context.addIssue({ code: "custom", path: ["operations", index, "uri"], message: "Resource operation source URIs must be unique." });
      }
      targets.add(operation.uri);
      if (operation.operation === "rename") {
        if (targets.has(operation.targetUri)) {
          context.addIssue({ code: "custom", path: ["operations", index, "targetUri"], message: "Resource operation target URIs must be unique." });
        }
        targets.add(operation.targetUri);
      }
      if (operation.operation === "create" && operation.content) {
        characters += operation.content.length;
      }
    }
    if (characters > MAX_RESOURCE_CHANGE_CHARACTERS) {
      context.addIssue({ code: "custom", message: "Resource creation text exceeds the total character limit." });
    }
  });
export const PrepareResourceChangesInputSchema = PrepareResourceChangesParamsSchema.safeExtend({
  instanceId: z.uuid(),
});

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
    rootUri: z.string().min(1),
    changeSetId: ChangeSetIdSchema,
    kind: z.enum(["text-edits", "rename", "resource-changes"]),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
    documents: z.array(PreparedDocumentChangeSchema),
    resources: z.array(ResourceChangeSchema).default([]),
    editCount: z.number().int().nonnegative(),
    resourceOperationCount: z.number().int().nonnegative().default(0),
    replacementCharacters: z.number().int().nonnegative(),
  })
  .strict();

export const ApplyChangeSetParamsSchema = z
  .object({
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
    changeSetId: ChangeSetIdSchema,
    appliedAt: z.string().min(1),
    documents: z.array(AppliedDocumentSchema),
    resources: z.array(ResourceChangeSchema).default([]),
  })
  .strict();

export type AppliedChangeSet = z.infer<typeof AppliedChangeSetSchema>;
export type ApplyChangeSetParams = z.infer<typeof ApplyChangeSetParamsSchema>;
export type PreparedChangeSet = z.infer<typeof PreparedChangeSetSchema>;
export type PreparedDocumentChange = z.infer<typeof PreparedDocumentChangeSchema>;
export type PrepareRenameParams = z.infer<typeof PrepareRenameParamsSchema>;
export type PrepareResourceChangesParams = z.infer<typeof PrepareResourceChangesParamsSchema>;
export type ResourceChange = z.infer<typeof ResourceChangeSchema>;
export type PrepareTextEditsParams = z.infer<typeof PrepareTextEditsParamsSchema>;
export type TextReplacement = z.infer<typeof TextReplacementSchema>;

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}
