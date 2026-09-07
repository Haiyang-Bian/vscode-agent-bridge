import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SERVICE_DIRECTORY_ENV, ServiceIdentitySchema, ServiceInstallationSchema,
  type ServiceIdentity, type ServiceInstallation,
} from "@vscode-agent-bridge/protocol";
import { ServiceError } from "./service-errors.js";
import { assertSid, hardenPrivatePath } from "./windows-service-native.js";

export interface ServicePaths {
  readonly directory: string;
  readonly identity: string;
  readonly installation: string;
  readonly transaction: string;
  readonly endpoint: string;
  readonly installEndpoint: string;
  readonly taskName: string;
  readonly serviceId: string;
  readonly userSid: string;
}

export async function resolveServicePaths(directoryOverride?: string): Promise<ServicePaths> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new ServiceError("SERVICE_PLATFORM_UNSUPPORTED", "The service requires Windows x64.");
  }
  const child = Bun.spawn([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), "/user", "/fo", "csv", "/nh"], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const userSid = (await new Response(child.stdout).text()).match(/S-1-(?:\d+-)+\d+/u)?.[0];
  if (await child.exited !== 0 || !userSid) throw new ServiceError("SERVICE_PERMISSION_DENIED", "The current Windows identity could not be verified.");
  assertSid(userSid);
  // Packaged clients can redirect LocalAppData writes into their private MSIX
  // cache. The external login task and VS Code must see the same installation.
  const standard = path.join(os.homedir(), ".vscode-agent-bridge", "service");
  const directory = path.resolve(directoryOverride ?? process.env[SERVICE_DIRECTORY_ENV] ?? standard);
  const isolated = directory.toLowerCase() !== path.resolve(standard).toLowerCase();
  const serviceId = createHash("sha256").update(`VSCodeAgentBridge:${userSid}${isolated ? ":isolated:" + directory.toLowerCase() : ""}`).digest("hex").slice(0, 32);
  return {
    directory, identity: path.join(directory, "service-identity.json"), installation: path.join(directory, "service-installation.json"),
    transaction: path.join(directory, "service-transaction.json"), endpoint: `\\\\.\\pipe\\VSCodeAgentBridge-${serviceId}`,
    installEndpoint: `\\\\.\\pipe\\VSCodeAgentBridge-install-${serviceId}`, taskName: `VSCodeAgentBridge-${serviceId}`,
    serviceId, userSid,
  };
}

export function newServiceIdentity(paths: ServicePaths, port: number): ServiceIdentity {
  return ServiceIdentitySchema.parse({ contractVersion: 1, serviceId: paths.serviceId, userSid: paths.userSid, port,
    mcpToken: randomBytes(32).toString("hex"), managementToken: randomBytes(32).toString("hex") });
}

export async function readIdentity(paths: ServicePaths): Promise<ServiceIdentity> {
  const raw = await readOptional(paths.identity);
  if (raw === null) throw new ServiceError("SERVICE_NOT_INSTALLED", "The shared HTTP service is not installed.");
  try {
    const identity = ServiceIdentitySchema.parse(JSON.parse(raw));
    if (identity.serviceId !== paths.serviceId || identity.userSid !== paths.userSid) throw new Error("Identity mismatch");
    return identity;
  } catch { throw new ServiceError("SERVICE_CONFIGURATION_INVALID", "The private service identity is invalid."); }
}

export async function readInstallation(paths: ServicePaths): Promise<ServiceInstallation | null> {
  const raw = await readOptional(paths.installation);
  if (raw === null) return null;
  try { return ServiceInstallationSchema.parse(JSON.parse(raw)); }
  catch { throw new ServiceError("SERVICE_CONFIGURATION_INVALID", "The service installation record is invalid."); }
}

export async function readOptional(target: string): Promise<string | null> {
  try { return await readFile(target, "utf8"); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

export async function ensurePrivateDirectory(target: string, sid: string): Promise<void> {
  await mkdir(target, { recursive: true });
  hardenPrivatePath(target, sid, true);
}

export async function writePrivateAtomic(target: string, content: string | Uint8Array, sid: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    // Empty temporary files are hardened before any credentials enter them.
    hardenPrivatePath(temporary, sid, false);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, target);
    // Same-directory NTFS rename preserves the already protected DACL. No
    // credential-bearing file is published before ACL establishment succeeds.
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function writePrivateJson(target: string, value: unknown, sid: string): Promise<void> {
  await writePrivateAtomic(target, `${JSON.stringify(value, null, 2)}\n`, sid);
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
