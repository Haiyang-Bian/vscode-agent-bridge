import { z } from "zod";

import { ContentSha256Schema } from "./experiments.js";

const InstanceIdSchema = z.string().uuid();
const SessionIdSchema = z.string().uuid();
const ExtensionIdSchema = z.string().min(3).max(300).regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu);
const UriSchema = z.string().min(1).max(20_000);
const JsonValueSchema: z.ZodType<unknown> = z.unknown().superRefine((value, context) => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > 100_000) {
      context.addIssue({ code: "custom", message: "Configuration values must be bounded JSON." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Configuration values must be serializable JSON." });
  }
});

export const ExtensionCandidateSchema = z
  .object({
    candidateId: z.string().uuid(),
    extensionId: ExtensionIdSchema,
    version: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    displayName: z.string().min(1).max(500),
    shortDescription: z.string().max(2_000).nullable(),
    source: z.enum(["builtIn", "installed", "marketplace"]),
    official: z.boolean(),
    officialDirectoryVersion: z.string().max(100).nullable(),
    verifiedPublisher: z.boolean(),
    installed: z.boolean(),
    installedVersion: z.string().max(200).nullable(),
    workspaceRecommended: z.boolean(),
    targetPlatform: z.string().max(100).nullable(),
    lastUpdated: z.string().datetime().nullable(),
    dependencies: z.array(ExtensionIdSchema).max(200),
    extensionPack: z.array(ExtensionIdSchema).max(200),
    repositoryUrl: z.string().url().max(2_000).nullable(),
    license: z.string().max(1_000).nullable(),
    installable: z.boolean(),
    rank: z.number().int().nonnegative(),
  })
  .strict();

export const SearchExtensionsParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    rootUri: UriSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export const SearchExtensionsInputSchema = SearchExtensionsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const SearchExtensionsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    candidates: z.array(ExtensionCandidateSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    cacheExpiresAt: z.string().datetime(),
    maintainerDirectoryVersion: z.string().min(1).max(100),
  })
  .strict();

export const PrepareExtensionInstallParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    rootUri: UriSchema,
    candidateId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const PrepareExtensionInstallInputSchema = PrepareExtensionInstallParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const PreparedExtensionSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    version: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    official: z.boolean(),
    verifiedPublisher: z.boolean(),
  })
  .strict();
export const PreparedExtensionInstallSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: SessionIdSchema,
    planId: z.string().uuid(),
    extension: PreparedExtensionSchema,
    dependencies: z.array(PreparedExtensionSchema).max(20),
    targetProfile: z.literal("current"),
    expiresAt: z.string().datetime(),
    alreadyInstalled: z.boolean(),
    recoverability: z.literal("none"),
  })
  .strict();

export const ApplyExtensionInstallParamsSchema = z
  .object({ sessionId: SessionIdSchema, planId: z.string().uuid() })
  .strict();
export const ApplyExtensionInstallInputSchema = ApplyExtensionInstallParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ApplyExtensionInstallResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: SessionIdSchema,
    planId: z.string().uuid(),
    extensionId: ExtensionIdSchema,
    plannedVersion: z.string().min(1).max(200),
    installedVersion: z.string().max(200).nullable(),
    status: z.enum(["installed", "alreadyInstalled", "pendingUserTrust", "pendingReload", "userActionRequired"]),
    pendingUserTrust: z.boolean(),
    pendingReload: z.boolean(),
    userActionRequired: z.boolean(),
    usedNativeInstallCommand: z.boolean(),
    recoverability: z.literal("none"),
  })
  .strict();

export const ExtensionConfigurationTargetSchema = z.enum(["global", "workspace", "workspaceFolder"]);
export const GetExtensionConfigurationParamsSchema = z
  .object({
    extensionId: ExtensionIdSchema,
    key: z.string().min(1).max(500),
    target: ExtensionConfigurationTargetSchema,
    rootUri: UriSchema.optional(),
  })
  .strict();
export const GetExtensionConfigurationInputSchema = GetExtensionConfigurationParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ExtensionConfigurationResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    extensionId: ExtensionIdSchema,
    key: z.string().min(1).max(500),
    target: ExtensionConfigurationTargetSchema,
    rootUri: UriSchema.nullable(),
    declaredTypes: z.array(z.string().max(100)).max(10),
    scope: z.string().max(100).nullable(),
    effectiveValueDefined: z.boolean(),
    effectiveValueSha256: ContentSha256Schema,
    effectiveValueType: z.string().max(100),
    targetValueSha256: ContentSha256Schema,
    targetValueDefined: z.boolean(),
    targetValueType: z.string().max(100),
    riskClass: z.enum(["ordinary", "executableOrPath", "network", "telemetry"]),
    sensitive: z.literal(false),
  })
  .strict();

export const UpdateExtensionConfigurationParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    rootUri: UriSchema,
    extensionId: ExtensionIdSchema,
    key: z.string().min(1).max(500),
    target: ExtensionConfigurationTargetSchema,
    expectedValueSha256: ContentSha256Schema,
    newValue: JsonValueSchema,
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const UpdateExtensionConfigurationInputSchema = UpdateExtensionConfigurationParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const UpdateExtensionConfigurationResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    sessionId: SessionIdSchema,
    extensionId: ExtensionIdSchema,
    key: z.string().min(1).max(500),
    target: ExtensionConfigurationTargetSchema,
    changed: z.boolean(),
    valueSha256: ContentSha256Schema,
    checkpointId: z.string().uuid().nullable(),
    globalChangeId: z.string().uuid().nullable(),
    recoverability: z.enum(["experiment", "globalJournal"]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ApplyExtensionInstallParams = z.infer<typeof ApplyExtensionInstallParamsSchema>;
export type ApplyExtensionInstallResult = z.infer<typeof ApplyExtensionInstallResultSchema>;
export type ExtensionCandidate = z.infer<typeof ExtensionCandidateSchema>;
export type ExtensionConfigurationResult = z.infer<typeof ExtensionConfigurationResultSchema>;
export type ExtensionConfigurationTarget = z.infer<typeof ExtensionConfigurationTargetSchema>;
export type GetExtensionConfigurationParams = z.infer<typeof GetExtensionConfigurationParamsSchema>;
export type PrepareExtensionInstallParams = z.infer<typeof PrepareExtensionInstallParamsSchema>;
export type PreparedExtension = z.infer<typeof PreparedExtensionSchema>;
export type PreparedExtensionInstall = z.infer<typeof PreparedExtensionInstallSchema>;
export type SearchExtensionsParams = z.infer<typeof SearchExtensionsParamsSchema>;
export type SearchExtensionsResult = z.infer<typeof SearchExtensionsResultSchema>;
export type UpdateExtensionConfigurationParams = z.infer<typeof UpdateExtensionConfigurationParamsSchema>;
export type UpdateExtensionConfigurationResult = z.infer<typeof UpdateExtensionConfigurationResultSchema>;
