import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION, ServiceStatusSchema, updateManagedConfigText,
  type ServiceIdentity, type ServiceInstallation, type ServiceStatus, type CodexConfigChangeResult,
} from "@vscode-agent-bridge/protocol";
import { controlRequest, stopVerifiedService, waitForReady } from "./service-control.js";
import { httpConnection, writeConfigChange, removeCodexConfigBlock } from "./service-config.js";
import { ServiceError } from "./service-errors.js";
import { createLoginTaskXml, isCurrentLoginTask, WindowsServiceScheduler, type ServiceScheduler } from "./service-scheduler.js";
import { ensurePrivateDirectory, newServiceIdentity, readIdentity, readInstallation, readOptional, writePrivateAtomic, writePrivateJson, type ServicePaths } from "./service-state.js";
import { WindowsControlPipe, hardenPrivatePath } from "./windows-service-native.js";

const EXECUTABLE_NAME = "vscode-agent-bridge-mcp.exe";
const TransactionSchema = z.object({
  contractVersion: z.literal(1), serviceId: z.string(), operation: z.enum(["install", "uninstall"]),
  previousIdentity: z.string().nullable(), previousInstallation: z.string().nullable(), previousTask: z.string().nullable(),
  previousStatus: ServiceStatusSchema.nullable(), configPath: z.string().nullable(), previousConfig: z.string().nullable(),
  publishedConfig: z.string().nullable(), candidateVersion: z.string(), candidateBootId: z.string().optional(),
}).strict();
type Transaction = z.infer<typeof TransactionSchema>;
export interface InstallOptions { readonly sourceExecutable: string; readonly configPath: string | null; readonly registryDirectory?: string; }
export interface InstallResult extends CodexConfigChangeResult { readonly executableInstalled: boolean; readonly status: ServiceStatus; }
export interface InstallerDependencies {
  readonly scheduler?: ServiceScheduler;
  readonly ready?: typeof waitForReady;
  readonly stop?: typeof stopVerifiedService;
  readonly current?: typeof controlRequest;
  readonly prepare?: typeof prepareExecutable;
}

export class ServiceInstaller {
  readonly scheduler: ServiceScheduler;
  readonly #ready: typeof waitForReady;
  readonly #stop: typeof stopVerifiedService;
  readonly #current: typeof controlRequest;
  readonly #prepare: typeof prepareExecutable;
  constructor(readonly paths: ServicePaths, dependencies: InstallerDependencies = {}) {
    this.scheduler = dependencies.scheduler ?? new WindowsServiceScheduler(paths);
    this.#ready = dependencies.ready ?? waitForReady;
    this.#stop = dependencies.stop ?? stopVerifiedService;
    this.#current = dependencies.current ?? controlRequest;
    this.#prepare = dependencies.prepare ?? prepareExecutable;
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.paths.directory, this.paths.userSid);
    const lock = WindowsControlPipe.acquire(this.paths.installEndpoint, this.paths.userSid, () => ({ busy: true }));
    if (!lock) throw new ServiceError("SERVICE_INSTALL_CONFLICT", "Another service management operation is in progress.");
    try { await this.#recover(); return await operation(); } finally { lock.close(); }
  }

  async install(options: InstallOptions): Promise<InstallResult> {
    return this.exclusive(async () => {
      const paths = this.paths;
      const prepared = await this.#prepare(paths, options.sourceExecutable);
      const previousIdentity = await readOptional(paths.identity);
      const identity = previousIdentity ? await readIdentity(paths) : newServiceIdentity(paths, allocatePort());
      const previousConfig = options.configPath ? await readOptional(options.configPath) : null;
      let publishedConfig: string | null;
      try { publishedConfig = options.configPath ? updateManagedConfigText(previousConfig ?? "", httpConnection(identity)) : null; }
      catch { throw new ServiceError("SERVICE_INSTALL_CONFLICT", "The Codex configuration is invalid or has an unmanaged bridge entry. Resolve the conflict before installation."); }
      const previousInstallation = await readOptional(paths.installation);
      const previousTask = await this.scheduler.query();
      if (previousTask && !previousInstallation) throw new ServiceError("SERVICE_INSTALL_CONFLICT", "An unowned login task already uses the installation identity.");
      const previousStatus = previousIdentity ? await this.#tryCurrent(identity) : null;
      const previousRecord = previousInstallation ? await readInstallation(paths) : null;
      if (previousRecord?.executableSha256 === prepared.sha256 && previousRecord.executablePath === prepared.executablePath &&
        previousRecord.codexConfigPath === options.configPath && previousStatus?.state === "ready" && previousStatus.version === BRIDGE_RELEASE_VERSION &&
        previousTask && isCurrentLoginTask(previousTask, paths, prepared.executablePath, options.registryDirectory)) {
        await this.#ready(paths, identity);
        const change = options.configPath && publishedConfig !== null ? await writeConfigChange(options.configPath, previousConfig, publishedConfig, paths.userSid) : { changed: false };
        return { ...change, executableInstalled: prepared.changed, status: previousStatus };
      }
      const transaction: Transaction = { contractVersion: 1, serviceId: paths.serviceId, operation: "install", previousIdentity,
        previousInstallation, previousTask, previousStatus, configPath: options.configPath, previousConfig, publishedConfig,
        candidateVersion: BRIDGE_RELEASE_VERSION };
      await writePrivateJson(paths.transaction, transaction, paths.userSid);
      try {
        if (!previousIdentity) await writePrivateJson(paths.identity, identity, paths.userSid);
        // Even an existing identity is re-protected before the service uses it.
        hardenPrivatePath(paths.identity, paths.userSid, false);
        if (previousStatus) await this.#stop(paths, identity, previousStatus);
        await this.scheduler.register(createLoginTaskXml(paths, prepared.executablePath, options.registryDirectory));
        await this.scheduler.run();
        const status = await this.#ready(paths, identity);
        if (status.version !== BRIDGE_RELEASE_VERSION || status.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new ServiceError("SERVICE_START_FAILED", "The new service version did not pass verification.");
        transaction.candidateBootId = status.bootId;
        await writePrivateJson(paths.transaction, transaction, paths.userSid);
        const configChange = options.configPath && publishedConfig !== null
          ? await writeConfigChange(options.configPath, previousConfig, publishedConfig, paths.userSid) : { changed: false };
        const installation: ServiceInstallation = { contractVersion: 1, version: BRIDGE_RELEASE_VERSION,
          executablePath: prepared.executablePath, executableSha256: prepared.sha256, taskName: paths.taskName,
          codexConfigPath: options.configPath, installedAt: new Date().toISOString() };
        await writePrivateJson(paths.installation, installation, paths.userSid);
        await rm(paths.transaction);
        return { ...configChange, executableInstalled: prepared.changed, status };
      } catch (error) {
        await this.#rollback(transaction);
        throw error;
      }
    });
  }

  async uninstall(): Promise<CodexConfigChangeResult> {
    return this.exclusive(async () => {
      const installation = await readInstallation(this.paths);
      if (!installation) return { changed: false };
      const identity = await readIdentity(this.paths);
      const configPath = installation.codexConfigPath;
      const transaction: Transaction = { contractVersion: 1, serviceId: this.paths.serviceId, operation: "uninstall",
        previousIdentity: await readOptional(this.paths.identity), previousInstallation: await readOptional(this.paths.installation),
        previousTask: await this.scheduler.query(), previousStatus: await this.#tryCurrent(identity), configPath,
        previousConfig: configPath ? await readOptional(configPath) : null, publishedConfig: null, candidateVersion: BRIDGE_RELEASE_VERSION };
      // Parse/conflict validation happens before stopping the service.
      const { removeManagedConfigText } = await import("@vscode-agent-bridge/protocol");
      transaction.publishedConfig = configPath ? removeManagedConfigText(transaction.previousConfig ?? "") : null;
      await writePrivateJson(this.paths.transaction, transaction, this.paths.userSid);
      try {
        if (transaction.previousStatus) await this.#stop(this.paths, identity, transaction.previousStatus);
        await this.scheduler.remove();
        const result = configPath ? await removeCodexConfigBlock(configPath, this.paths.userSid) : { changed: false };
        await rm(this.paths.installation, { force: true });
        // Keep the protected identity (stable port) and version files for recovery.
        await rm(this.paths.transaction);
        return result;
      } catch (error) { await this.#rollback(transaction); throw error; }
    });
  }

  async start(): Promise<ServiceStatus> {
    return this.exclusive(async () => {
      const identity = await readIdentity(this.paths);
      if (!await readInstallation(this.paths)) throw new ServiceError("SERVICE_NOT_INSTALLED", "The shared HTTP service is not installed.");
      const current = await this.#tryCurrent(identity);
      if (current?.state === "ready") return this.#ready(this.paths, identity);
      await this.scheduler.run();
      return this.#ready(this.paths, identity);
    });
  }

  async stop(): Promise<void> {
    return this.exclusive(async () => {
      const identity = await readIdentity(this.paths);
      const status = await this.#tryCurrent(identity);
      if (status) await this.#stop(this.paths, identity, status);
    });
  }

  async current(identity: ServiceIdentity): Promise<ServiceStatus | null> { return this.#tryCurrent(identity); }

  async #tryCurrent(identity: ServiceIdentity): Promise<ServiceStatus | null> {
    try { return await this.#current(this.paths, identity, "status"); }
    catch {
      // Verify absence with the same OS-exclusive primitive. An occupied but
      // unauthenticated endpoint is an error, never permission to start another.
      const probe = WindowsControlPipe.acquire(this.paths.endpoint, this.paths.userSid, () => ({}));
      if (!probe) throw new ServiceError("SERVICE_IDENTITY_UNVERIFIED", "An occupied singleton endpoint could not be authenticated.");
      probe.close();
      return null;
    }
  }

  async #recover(): Promise<void> {
    const raw = await readOptional(this.paths.transaction);
    if (raw === null) return;
    let transaction: Transaction;
    try {
      transaction = TransactionSchema.parse(JSON.parse(raw));
      if (transaction.serviceId !== this.paths.serviceId) throw new Error();
    } catch { throw new ServiceError("SERVICE_CONFIGURATION_INVALID", "The interrupted installation record requires manual recovery."); }
    await this.#rollback(transaction);
  }

  async #rollback(transaction: Transaction): Promise<void> {
    try {
      const identityRaw = await readOptional(this.paths.identity);
      if (identityRaw) {
        const identity = await readIdentity(this.paths);
        const current = await this.#tryCurrent(identity);
        if (current && current.bootId !== transaction.previousStatus?.bootId) {
          if (current.version !== transaction.candidateVersion || (transaction.candidateBootId && current.bootId !== transaction.candidateBootId)) throw new Error();
          await this.#stop(this.paths, identity, current);
        }
      }
      if (transaction.previousTask) await this.scheduler.register(transaction.previousTask); else await this.scheduler.remove();
      if (transaction.configPath) {
        const current = await readOptional(transaction.configPath);
        if (current !== transaction.previousConfig && current !== transaction.publishedConfig) {
          throw new ServiceError("SERVICE_INSTALL_CONFLICT", "Concurrent Codex edits were preserved. The protected rollback record requires review.");
        }
        await restore(this.paths, transaction.configPath, transaction.previousConfig);
      }
      await restore(this.paths, this.paths.identity, transaction.previousIdentity);
      await restore(this.paths, this.paths.installation, transaction.previousInstallation);
      if (transaction.previousStatus && transaction.previousTask && transaction.previousIdentity) {
        await this.scheduler.run();
        await this.#ready(this.paths, await readIdentity(this.paths));
      }
      await rm(this.paths.transaction);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "SERVICE_INSTALL_CONFLICT") throw error;
      throw new ServiceError("SERVICE_INSTALL_FAILED", "Installation rollback could not finish. The private recovery record was retained; retry service management to recover.");
    }
  }
}

async function restore(paths: ServicePaths, target: string, value: string | null): Promise<void> {
  if (value === null) await rm(target, { force: true }); else await writePrivateAtomic(target, value, paths.userSid);
}
function allocatePort(): number {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  const port = listener.port!;
  void listener.stop(true);
  return port;
}
export async function prepareExecutable(paths: ServicePaths, source: string): Promise<{ executablePath: string; sha256: string; changed: boolean }> {
  const data = await readFile(source);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const sidecar = await readOptional(`${source}.sha256`);
  if (sidecar && sidecar.trim().toLowerCase() !== sha256) throw new ServiceError("SERVICE_INSTALL_FAILED", "The executable checksum does not match its sidecar.");
  const target = path.join(paths.directory, "versions", BRIDGE_RELEASE_VERSION, sha256.slice(0, 16), EXECUTABLE_NAME);
  await ensurePrivateDirectory(path.dirname(target), paths.userSid);
  let changed = true;
  try { changed = createHash("sha256").update(await readFile(target)).digest("hex") !== sha256; } catch { /* First installation. */ }
  if (changed) await writePrivateAtomic(target, data, paths.userSid);
  const child = Bun.spawn([target, "--self-test"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(output);
    if (code !== 0 || result.version !== BRIDGE_RELEASE_VERSION || result.protocolVersion !== BRIDGE_PROTOCOL_VERSION ||
      result.transport !== "streamable-http" || result.platform !== "win32" || result.architecture !== "x64") throw new Error();
  } catch { throw new ServiceError("SERVICE_INSTALL_FAILED", "The staged executable failed its diagnostic self-test."); }
  finally { clearTimeout(timer); }
  return { executablePath: target, sha256, changed };
}
