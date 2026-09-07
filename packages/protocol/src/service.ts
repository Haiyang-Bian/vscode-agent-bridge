import { z } from "zod";

// Independent of the extension RPC protocol and of product release versions.
export const SERVICE_CONTRACT_VERSION = 1 as const;
export const SERVICE_DIRECTORY_ENV = "VSCODE_AGENT_BRIDGE_SERVICE_DIR";
export const SERVICE_LIMITS = {
  sessions: 128,
  requestsPerSession: 8,
  requestsGlobal: 64,
  sessionIdleMs: 30 * 60_000,
  requestTimeoutMs: 120_000,
  shutdownGraceMs: 10_000,
  managementMessageBytes: 16_384,
} as const;

const SecretSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ServiceIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
export const ServiceIdentitySchema = z.object({
  contractVersion: z.literal(SERVICE_CONTRACT_VERSION),
  serviceId: ServiceIdSchema,
  userSid: z.string().regex(/^S-1-(?:\d+-)+\d+$/u),
  port: z.number().int().min(1024).max(65535),
  mcpToken: SecretSchema,
  managementToken: SecretSchema,
}).strict();
export type ServiceIdentity = z.infer<typeof ServiceIdentitySchema>;

export const ServiceStatusSchema = z.object({
  contractVersion: z.literal(SERVICE_CONTRACT_VERSION),
  serviceId: ServiceIdSchema,
  bootId: z.string().uuid(),
  pid: z.number().int().positive(),
  version: z.string().max(64),
  protocolVersion: z.number().int().positive(),
  state: z.enum(["starting", "ready", "stopping"]),
  port: z.number().int().min(1).max(65535),
  sessions: z.number().int().nonnegative(),
  activeRequests: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
}).strict();
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const ServiceManagementRequestSchema = z.object({
  contractVersion: z.literal(SERVICE_CONTRACT_VERSION),
  serviceId: ServiceIdSchema,
  nonce: z.string().regex(/^[a-f0-9]{32}$/u),
  timestamp: z.number().int().nonnegative(),
  proof: SecretSchema,
  command: z.enum(["status", "stop"]),
  expectedBootId: z.string().uuid().optional(),
}).strict();
export const ServiceManagementResponseSchema = z.object({
  nonce: z.string().regex(/^[a-f0-9]{32}$/u),
  status: ServiceStatusSchema,
  proof: SecretSchema,
}).strict();

export const ServiceInstallationSchema = z.object({
  contractVersion: z.literal(SERVICE_CONTRACT_VERSION),
  version: z.string().max(64),
  executablePath: z.string().min(1).max(4096),
  executableSha256: SecretSchema,
  taskName: z.string().min(1).max(240),
  codexConfigPath: z.string().min(1).max(4096).nullable(),
  installedAt: z.string().datetime(),
}).strict();
export type ServiceInstallation = z.infer<typeof ServiceInstallationSchema>;

export const SERVICE_ERROR_CODES = [
  "SERVICE_NOT_INSTALLED", "SERVICE_CONFIGURATION_INVALID", "SERVICE_PERMISSION_DENIED",
  "SERVICE_ALREADY_STARTING", "SERVICE_IDENTITY_UNVERIFIED", "SERVICE_AUTHENTICATION_FAILED",
  "SERVICE_PORT_IN_USE", "SERVICE_START_FAILED", "SERVICE_STOP_TIMEOUT", "SERVICE_INSTALL_CONFLICT",
  "SERVICE_INSTALL_FAILED", "SERVICE_PLATFORM_UNSUPPORTED", "SERVICE_SCHEDULER_FAILED",
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
