import { z } from "zod";

import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_TERMINAL_OUTPUT_CHARACTERS,
} from "./constants.js";

const InstanceIdSchema = z.string().uuid();
const ExtensionIdSchema = z.string().min(3).max(300).regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu);
const UriSchema = z.string().min(1).max(20_000);
const CursorSchema = z.number().int().nonnegative();
const PageSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();

export const ExtensionKindSchema = z.enum(["ui", "workspace", "web", "unknown"]);
export const ExtensionContributionCountsSchema = z
  .object({
    languages: z.number().int().nonnegative(),
    debuggers: z.number().int().nonnegative(),
    taskDefinitions: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    configurationKeys: z.number().int().nonnegative(),
    themes: z.number().int().nonnegative(),
    testing: z.boolean(),
    formatterDeclarationCoverage: z.literal("notDeclaredByManifest"),
  })
  .strict();

export const ExtensionSummarySchema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    displayName: z.string().min(1).max(500),
    builtIn: z.boolean(),
    active: z.boolean(),
    extensionKind: z.array(ExtensionKindSchema).max(3),
    dependencies: z.array(ExtensionIdSchema).max(200),
    extensionPack: z.array(ExtensionIdSchema).max(200),
    contributions: ExtensionContributionCountsSchema,
  })
  .strict();

export const ListExtensionsParamsSchema = PageSchema.extend({
  query: z.string().max(500).optional(),
  activeOnly: z.boolean().default(false),
  includeBuiltIn: z.boolean().default(true),
}).strict();
export const ListExtensionsInputSchema = ListExtensionsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ListExtensionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    extensions: z.array(ExtensionSummarySchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const GetExtensionDetailsParamsSchema = z.object({ extensionId: ExtensionIdSchema }).strict();
export const GetExtensionDetailsInputSchema = GetExtensionDetailsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();

const LanguageContributionSchema = z
  .object({
    id: z.string().min(1).max(200),
    aliases: z.array(z.string().max(500)).max(50),
    extensions: z.array(z.string().max(200)).max(100),
  })
  .strict();
const NamedTypeContributionSchema = z
  .object({ type: z.string().min(1).max(300), label: z.string().max(500).nullable() })
  .strict();
const CommandContributionSchema = z
  .object({ command: z.string().min(1).max(500), title: z.string().min(1).max(1_000) })
  .strict();

export const ExtensionDetailsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    extension: ExtensionSummarySchema,
    activationEvents: z.array(z.string().max(500)).max(500),
    languages: z.array(LanguageContributionSchema).max(500),
    debuggers: z.array(NamedTypeContributionSchema).max(200),
    taskDefinitions: z.array(NamedTypeContributionSchema).max(200),
    commands: z.array(CommandContributionSchema).max(1_000),
    configurationKeys: z.array(z.string().max(500)).max(2_000),
    themes: z.array(
      z
        .object({
          id: z.string().max(300).nullable(),
          label: z.string().max(500).nullable(),
          uiTheme: z.string().max(200).nullable(),
        })
        .strict(),
    ).max(500),
    activatedByRequest: z.literal(false),
  })
  .strict();

export const GetExtensionConfigurationSchemaParamsSchema = PageSchema.extend({
  extensionId: ExtensionIdSchema,
}).strict();
export const GetExtensionConfigurationSchemaInputSchema =
  GetExtensionConfigurationSchemaParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();
export const ExtensionConfigurationPropertySchema = z
  .object({
    key: z.string().min(1).max(500),
    type: z.array(z.string().max(100)).max(10),
    scope: z.string().max(100).nullable(),
    description: z.string().max(4_000).nullable(),
    enumValues: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(200),
  })
  .strict();
export const ExtensionConfigurationSchemaResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    extensionId: ExtensionIdSchema,
    properties: z.array(ExtensionConfigurationPropertySchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const GetProfileContextParamsSchema = z.object({}).strict();
export const GetProfileContextInputSchema = z.object({ instanceId: InstanceIdSchema }).strict();
export const ProfileContextResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    profileName: z.string().max(500).nullable(),
    profileId: z.string().max(500).nullable(),
    stableApiCoverage: z.enum(["full", "partial", "unavailable"]),
    canManageCurrentProfileConfiguration: z.boolean(),
    supportedConfigurationTargets: z.array(z.enum(["global", "workspace", "workspaceFolder"])),
    privateProfileDataAccessed: z.literal(false),
  })
  .strict();

export const OutputSourceKindSchema = z.enum([
  "outputDocument",
  "terminalCapture",
  "taskCapture",
  "debugCapture",
  "diagnostics",
  "extensionCapability",
  "adapter",
]);
export const OutputCoverageSchema = z.enum(["metadataOnly", "visible", "captured", "adapter"]);
export const OutputSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(500),
    extensionId: ExtensionIdSchema.nullable(),
    label: z.string().min(1).max(1_000),
    sourceType: OutputSourceKindSchema,
    status: z.enum(["available", "active", "emitting", "inactive", "unknown"]),
    coverage: OutputCoverageSchema,
    canReadNow: z.boolean(),
    lastObservedAt: z.string().datetime().nullable(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  })
  .strict();

export const ListOutputSourcesParamsSchema = PageSchema.extend({
  rootUri: UriSchema.optional(),
  sourceTypes: z.array(OutputSourceKindSchema).max(20).optional(),
}).strict();
export const ListOutputSourcesInputSchema = ListOutputSourcesParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ListOutputSourcesResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sources: z.array(OutputSourceSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const ReadVisibleOutputParamsSchema = z
  .object({
    sourceId: z.string().min(1).max(500),
    cursor: CursorSchema.default(0),
    maxChars: z.number().int().positive().max(MAX_TERMINAL_OUTPUT_CHARACTERS).default(65_536),
  })
  .strict();
export const ReadVisibleOutputInputSchema = ReadVisibleOutputParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ReadVisibleOutputResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sourceId: z.string().min(1).max(500),
    text: z.string().max(MAX_TERMINAL_OUTPUT_CHARACTERS),
    cursor: CursorSchema,
    nextCursor: CursorSchema,
    returnedCharacters: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
    droppedPrefix: z.boolean(),
    coverage: z.literal("visible"),
  })
  .strict();

export const DiagnosticEventSchema = z
  .object({
    cursor: CursorSchema,
    occurredAt: z.string().datetime(),
    uri: UriSchema,
    change: z.enum(["added", "removed", "changed"]),
    previousCount: z.number().int().nonnegative(),
    currentCount: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    information: z.number().int().nonnegative(),
    hints: z.number().int().nonnegative(),
    sources: z.array(z.string().max(500)).max(200),
  })
  .strict();
export const ListDiagnosticEventsParamsSchema = z
  .object({
    rootUri: UriSchema.optional(),
    afterCursor: CursorSchema.default(0),
    severity: z.enum(["error", "warning", "information", "hint"]).optional(),
    source: z.string().max(500).optional(),
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();
export const ListDiagnosticEventsInputSchema = ListDiagnosticEventsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ListDiagnosticEventsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    events: z.array(DiagnosticEventSchema),
    oldestCursor: CursorSchema,
    nextCursor: CursorSchema,
    cursorExpired: z.boolean(),
    truncated: z.boolean(),
    coverage: z.literal("sinceActivation"),
  })
  .strict();

export const DebugOutputCategorySchema = z.enum(["stdout", "stderr", "console", "important"]);
export const DebugOutputSessionSchema = z
  .object({
    debugSessionId: z.string().min(1).max(500),
    name: z.string().min(1).max(1_000),
    status: z.enum(["active", "ended"]),
    coverage: z.literal("sinceActivation"),
    eventCount: z.number().int().nonnegative(),
    droppedCharacters: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
  })
  .strict();
export const ListDebugOutputParamsSchema = PageSchema.extend({
  rootUri: UriSchema.optional(),
  includeTerminated: z.boolean().default(true),
}).strict();
export const ListDebugOutputInputSchema = ListDebugOutputParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ListDebugOutputResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessions: z.array(DebugOutputSessionSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const ReadDebugOutputParamsSchema = z
  .object({
    debugSessionId: z.string().min(1).max(500),
    cursor: CursorSchema.default(0),
    maxChars: z.number().int().positive().max(MAX_TERMINAL_OUTPUT_CHARACTERS).default(65_536),
    categories: z.array(DebugOutputCategorySchema).max(4).optional(),
  })
  .strict();
export const ReadDebugOutputInputSchema = ReadDebugOutputParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const DebugOutputEventSchema = z
  .object({
    cursor: CursorSchema,
    occurredAt: z.string().datetime(),
    category: DebugOutputCategorySchema,
    text: z.string().max(MAX_TERMINAL_OUTPUT_CHARACTERS),
    sourcePath: z.string().min(1).max(4_000).nullable(),
    line: z.number().int().nonnegative().nullable(),
    character: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const ReadDebugOutputResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    debugSessionId: z.string().min(1).max(500),
    events: z.array(DebugOutputEventSchema),
    nextCursor: CursorSchema,
    returnedCharacters: z.number().int().nonnegative(),
    totalEvents: z.number().int().nonnegative(),
    truncated: z.boolean(),
    droppedCharacters: z.number().int().nonnegative(),
    coverage: z.literal("sinceActivation"),
  })
  .strict();

export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export type DebugOutputCategory = z.infer<typeof DebugOutputCategorySchema>;
export type ExtensionDetailsResult = z.infer<typeof ExtensionDetailsResultSchema>;
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
export type GetExtensionConfigurationSchemaParams = z.infer<typeof GetExtensionConfigurationSchemaParamsSchema>;
export type GetExtensionDetailsParams = z.infer<typeof GetExtensionDetailsParamsSchema>;
export type ListDebugOutputParams = z.infer<typeof ListDebugOutputParamsSchema>;
export type ListDebugOutputResult = z.infer<typeof ListDebugOutputResultSchema>;
export type ListDiagnosticEventsParams = z.infer<typeof ListDiagnosticEventsParamsSchema>;
export type ListDiagnosticEventsResult = z.infer<typeof ListDiagnosticEventsResultSchema>;
export type ListExtensionsParams = z.infer<typeof ListExtensionsParamsSchema>;
export type ListExtensionsResult = z.infer<typeof ListExtensionsResultSchema>;
export type ListOutputSourcesParams = z.infer<typeof ListOutputSourcesParamsSchema>;
export type ListOutputSourcesResult = z.infer<typeof ListOutputSourcesResultSchema>;
export type OutputSource = z.infer<typeof OutputSourceSchema>;
export type ReadDebugOutputParams = z.infer<typeof ReadDebugOutputParamsSchema>;
export type ReadDebugOutputResult = z.infer<typeof ReadDebugOutputResultSchema>;
export type ReadVisibleOutputParams = z.infer<typeof ReadVisibleOutputParamsSchema>;
export type ReadVisibleOutputResult = z.infer<typeof ReadVisibleOutputResultSchema>;
