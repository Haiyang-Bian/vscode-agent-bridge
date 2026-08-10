import { z } from "zod";

const InstanceIdSchema = z.string().uuid();
const UriSchema = z.string().min(1).max(20_000);

export const PYTHON_ENVIRONMENT_INTEGRATION_ID = "python.environment" as const;
export const PYTHON_EXTENSION_ID = "ms-python.python" as const;
export const PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE = ">=2024.23.0 <2027.0.0" as const;

export const ExtensionIntegrationIdSchema = z.literal(PYTHON_ENVIRONMENT_INTEGRATION_ID);
export const ExtensionIntegrationAvailabilitySchema = z.enum([
  "available",
  "notInstalled",
  "versionUnsupported",
]);

export const ExtensionIntegrationSummarySchema = z
  .object({
    integrationId: ExtensionIntegrationIdSchema,
    extensionId: z.literal(PYTHON_EXTENSION_ID),
    displayName: z.string().min(1).max(500),
    supportedVersionRange: z.literal(PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE),
    activationPolicy: z.literal("onStateRequest"),
    dataSensitivity: z.literal("workspaceMetadata"),
    installed: z.boolean(),
    installedVersion: z.string().min(1).max(200).nullable(),
    availability: ExtensionIntegrationAvailabilitySchema,
  })
  .strict();

export const ListExtensionIntegrationsParamsSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export const ListExtensionIntegrationsInputSchema = ListExtensionIntegrationsParamsSchema.extend({
  instanceId: InstanceIdSchema,
}).strict();
export const ListExtensionIntegrationsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    integrations: z.array(ExtensionIntegrationSummarySchema).max(100),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const GetExtensionIntegrationStateParamsSchema = z
  .object({
    integrationId: ExtensionIntegrationIdSchema,
    rootUri: UriSchema,
  })
  .strict();
export const GetExtensionIntegrationStateInputSchema =
  GetExtensionIntegrationStateParamsSchema.extend({ instanceId: InstanceIdSchema }).strict();

export const PythonEnvironmentVersionSchema = z
  .object({
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    micro: z.number().int().nonnegative(),
    releaseLevel: z.enum(["alpha", "beta", "candidate", "final"]).nullable(),
    releaseSerial: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const PythonEnvironmentStateSchema = z
  .object({
    interpreterPath: z.string().min(1).max(20_000).nullable(),
    environmentType: z.string().min(1).max(500).nullable(),
    environmentName: z.string().min(1).max(500).nullable(),
    version: PythonEnvironmentVersionSchema.nullable(),
    architecture: z.string().min(1).max(100).nullable(),
  })
  .strict();

export const ExtensionIntegrationStateResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    integrationId: ExtensionIntegrationIdSchema,
    extensionId: z.literal(PYTHON_EXTENSION_ID),
    rootUri: UriSchema,
    installedVersion: z.string().min(1).max(200).nullable(),
    status: z.enum(["unavailable", "unresolved", "resolved"]),
    reason: z.enum(["notInstalled", "noActiveEnvironment"]).nullable(),
    activatedByRequest: z.boolean(),
    environment: PythonEnvironmentStateSchema.nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();

export type ExtensionIntegrationStateResult = z.infer<
  typeof ExtensionIntegrationStateResultSchema
>;
export type ExtensionIntegrationSummary = z.infer<typeof ExtensionIntegrationSummarySchema>;
export type GetExtensionIntegrationStateParams = z.infer<
  typeof GetExtensionIntegrationStateParamsSchema
>;
export type ListExtensionIntegrationsParams = z.infer<
  typeof ListExtensionIntegrationsParamsSchema
>;
export type ListExtensionIntegrationsResult = z.infer<
  typeof ListExtensionIntegrationsResultSchema
>;
