import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  BridgeError,
  CheckpointIdSchema,
  ContentSha256Schema,
  ExperimentCheckpointSchema,
  ExperimentHealthSchema,
  ExperimentIdSchema,
  ExperimentInfoSchema,
  ExperimentLifecycleSchema,
  ManagedExperimentInfoSchema,
  ManagedExperimentStateSchema,
  ExperimentModeSchema,
  GitObjectIdSchema,
  type ExperimentCheckpoint,
  type ExperimentEvidence,
  type ExperimentInfo,
} from "@vscode-agent-bridge/protocol";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const EXPERIMENT_STORAGE_SCHEMA_VERSION = 1;
export const DEFAULT_EXPERIMENT_RETENTION_DAYS = 30;
export const DEFAULT_EXPERIMENT_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024;
export const MAX_EXPERIMENT_BLOB_BYTES = 2 * 1024 * 1024;
export const EXPERIMENT_LEASE_STALE_MS = 30_000;
const ATOMIC_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const atomicWriteQueues = new Map<string, Promise<void>>();
const manifestMutationQueues = new Map<string, Promise<void>>();

const StoredDocumentSchema = z
  .object({
    uri: z.string().min(1),
    languageId: z.string(),
    documentVersion: z.number().int().nonnegative().nullable(),
    isDirty: z.boolean(),
    exists: z.boolean(),
    blobSha256: ContentSha256Schema.nullable(),
    contentSha256: ContentSha256Schema.nullable(),
  })
  .strict();

const StoredCheckpointSchema = ExperimentCheckpointSchema.extend({
  documents: z.array(StoredDocumentSchema),
}).strict();

const StoredEvidenceEventSchema = z
  .object({
    type: z.literal("evidence"),
    checkpointId: CheckpointIdSchema,
    evidence: ExperimentCheckpointSchema.shape.evidence.element,
  })
  .strict();

const ExperimentManifestSchema = z
  .object({
    schemaVersion: z.literal(EXPERIMENT_STORAGE_SCHEMA_VERSION),
    sessionId: ExperimentIdSchema,
    mode: ExperimentModeSchema,
    lifecycle: ExperimentLifecycleSchema,
    health: ExperimentHealthSchema,
    title: z.string().min(1),
    rootUri: z.string().min(1),
    workspaceIdentity: z.string().min(1),
    baseRevision: GitObjectIdSchema.nullable(),
    branch: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    currentCheckpointId: CheckpointIdSchema.nullable(),
    acceptedCheckpointId: CheckpointIdSchema.nullable(),
    checkpointIds: z.array(CheckpointIdSchema),
    nextSequence: z.number().int().nonnegative(),
    pinned: z.boolean(),
    storageBytes: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();

const LeaseSchema = z
  .object({
    sessionId: ExperimentIdSchema,
    ownerInstanceId: z.uuid(),
    updatedAt: z.string().min(1),
  })
  .strict();

const ManagedExperimentMetadataSchema = ManagedExperimentInfoSchema.extend({
  schemaVersion: z.literal(1),
  repositoryRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  syncTargetHead: GitObjectIdSchema.nullable(),
}).strict();

export type StoredDocument = z.infer<typeof StoredDocumentSchema>;
export type StoredCheckpoint = z.infer<typeof StoredCheckpointSchema>;
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;
export type ManagedExperimentMetadata = z.infer<typeof ManagedExperimentMetadataSchema>;

export interface CreateExperimentInput {
  readonly sessionId?: string;
  readonly mode: "workspace" | "worktree";
  readonly title: string;
  readonly rootUri: string;
  readonly workspaceIdentity: string;
  readonly baseRevision: string | null;
  readonly branch: string | null;
  readonly health: "complete" | "partial";
  readonly warnings?: readonly string[];
  readonly baselineDocuments?: readonly StoredDocument[];
}

export interface AppendCheckpointInput {
  readonly source: ExperimentCheckpoint["source"];
  readonly summary: string;
  readonly documents: readonly StoredDocument[];
  readonly coverageComplete: boolean;
  readonly gitCommit?: string | null;
  readonly evidence?: readonly ExperimentEvidence[];
}

export interface ExperimentStoreOptions {
  readonly now?: () => Date;
  readonly retentionDays?: number;
  readonly storageLimitBytes?: number;
}

export interface ExperimentStoreStats {
  readonly sessionCount: number;
  readonly activeCount: number;
  readonly corruptCount: number;
  readonly storageBytes: number;
}

export class ExperimentStore {
  readonly #rootDirectory: string;
  readonly #sessionsDirectory: string;
  readonly #blobsDirectory: string;
  readonly #leasesDirectory: string;
  readonly #instanceId: string;
  readonly #now: () => Date;
  readonly #retentionDays: number;
  readonly #storageLimitBytes: number;
  #initializePromise: Promise<void> | undefined;

  constructor(
    rootDirectory: string,
    instanceId: string,
    options: ExperimentStoreOptions = {},
  ) {
    this.#rootDirectory = path.resolve(rootDirectory);
    this.#sessionsDirectory = path.join(this.#rootDirectory, "sessions");
    this.#blobsDirectory = path.join(this.#rootDirectory, "blobs", "sha256");
    this.#leasesDirectory = path.join(this.#rootDirectory, "leases");
    this.#instanceId = instanceId;
    this.#now = options.now ?? (() => new Date());
    this.#retentionDays = options.retentionDays ?? DEFAULT_EXPERIMENT_RETENTION_DAYS;
    this.#storageLimitBytes =
      options.storageLimitBytes ?? DEFAULT_EXPERIMENT_STORAGE_LIMIT_BYTES;
  }

  async initialize(): Promise<void> {
    this.#initializePromise ??= (async () => {
      await Promise.all([
        mkdir(this.#sessionsDirectory, { recursive: true }),
        mkdir(this.#blobsDirectory, { recursive: true }),
        mkdir(this.#leasesDirectory, { recursive: true }),
      ]);
      await this.#recoverSessions();
    })();
    await this.#initializePromise;
  }

  async createExperiment(input: CreateExperimentInput): Promise<ExperimentManifest> {
    await this.initialize();
    const sessionId = input.sessionId ?? randomUUID();
    assertUuid(sessionId);
    const now = this.#now().toISOString();
    const manifest: ExperimentManifest = {
      schemaVersion: EXPERIMENT_STORAGE_SCHEMA_VERSION,
      sessionId,
      mode: input.mode,
      lifecycle: "active",
      health: input.health,
      title: input.title,
      rootUri: input.rootUri,
      workspaceIdentity: input.workspaceIdentity,
      baseRevision: input.baseRevision,
      branch: input.branch,
      createdAt: now,
      updatedAt: now,
      currentCheckpointId: null,
      acceptedCheckpointId: null,
      checkpointIds: [],
      nextSequence: 0,
      pinned: false,
      storageBytes: 0,
      warnings: [...(input.warnings ?? [])],
    };

    await mkdir(this.#eventsDirectory(sessionId), { recursive: true });
    await this.#writeManifest(manifest);
    await this.acquireLease(sessionId);
    return this.appendCheckpoint(sessionId, {
      source: "baseline",
      summary: "Experiment baseline",
      documents: input.baselineDocuments ?? [],
      coverageComplete: input.health === "complete",
      gitCommit: input.baseRevision,
    });
  }

  async readManifest(sessionId: string): Promise<ExperimentManifest> {
    assertUuid(sessionId);
    const value = JSON.parse(await readFile(this.#manifestPath(sessionId), "utf8"));
    return ExperimentManifestSchema.parse(value);
  }

  async listManifests(): Promise<ExperimentManifest[]> {
    await this.initialize();
    const entries = await readdir(this.#sessionsDirectory, { withFileTypes: true });
    const manifests: ExperimentManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ExperimentIdSchema.safeParse(entry.name).success) {
        continue;
      }
      try {
        manifests.push(await this.readManifest(entry.name));
      } catch {
        // A corrupt session is kept on disk for explicit recovery or deletion.
      }
    }
    return manifests.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async renameOrdinaryExperiment(
    sessionId: string,
    expectedTitle: string,
    title: string,
  ): Promise<ExperimentManifest> {
    assertUuid(sessionId);
    const manifestPath = this.#manifestPath(sessionId);
    return serializeManifestMutation(manifestPath, async () => {
      const manifest = await this.readManifest(sessionId);
      if (manifest.mode !== "workspace") {
        throw new BridgeError(
          "POLICY_DENIED",
          "Managed Worktree experiment metadata remains user-controlled.",
        );
      }
      if (manifest.health === "corrupt") {
        throw new BridgeError(
          "EXPERIMENT_NOT_OWNED",
          "Corrupt experiment metadata cannot be changed by the Agent.",
        );
      }
      if (manifest.lifecycle === "active") {
        await this.assertLease(sessionId);
      }
      if (manifest.title !== expectedTitle) {
        throw new BridgeError(
          "EXPERIMENT_STATE_CHANGED",
          "The experiment title changed after it was inspected.",
        );
      }
      const updated = ExperimentManifestSchema.parse({
        ...manifest,
        title,
        updatedAt: this.#now().toISOString(),
      });
      await this.#writeManifest(updated);
      return updated;
    });
  }

  async appendCheckpoint(
    sessionId: string,
    input: AppendCheckpointInput,
  ): Promise<ExperimentManifest> {
    await this.assertLease(sessionId);
    const manifest = await this.readManifest(sessionId);
    if (manifest.lifecycle !== "active") {
      throw new Error("Cannot append a checkpoint to a completed experiment.");
    }
    const checkpointId = randomUUID();
    const createdAt = this.#now().toISOString();
    const checkpoint: StoredCheckpoint = {
      checkpointId,
      parentCheckpointId: manifest.currentCheckpointId,
      sequence: manifest.nextSequence,
      createdAt,
      source: input.source,
      summary: input.summary,
      documentCount: input.documents.length,
      coverageComplete: input.coverageComplete,
      gitCommit: input.gitCommit ?? null,
      evidence: [...(input.evidence ?? [])],
      documents: [...input.documents],
    };
    StoredCheckpointSchema.parse(checkpoint);
    await writeAtomic(
      this.#eventPath(sessionId, checkpoint.sequence, checkpointId),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    );

    const updated: ExperimentManifest = {
      ...manifest,
      health: input.coverageComplete ? manifest.health : "partial",
      currentCheckpointId: checkpointId,
      checkpointIds: [...manifest.checkpointIds, checkpointId],
      nextSequence: manifest.nextSequence + 1,
      updatedAt: createdAt,
    };
    await this.#writeManifest(updated);
    return updated;
  }

  async readCheckpoint(sessionId: string, checkpointId: string): Promise<StoredCheckpoint> {
    const manifest = await this.readManifest(sessionId);
    const index = manifest.checkpointIds.indexOf(checkpointId);
    if (index === -1) {
      throw new Error("Experiment checkpoint was not found.");
    }
    const files = await readdir(this.#eventsDirectory(sessionId));
    const suffix = `-${checkpointId}.json`;
    const eventFile = files.find((file) => file.endsWith(suffix));
    if (!eventFile) {
      throw new Error("Experiment checkpoint event is missing.");
    }
    const value = JSON.parse(
      await readFile(path.join(this.#eventsDirectory(sessionId), eventFile), "utf8"),
    );
    const checkpoint = StoredCheckpointSchema.parse(value);
    const evidenceEvents = await Promise.all(
      files
        .filter((file) => file.includes(`-${checkpointId}-evidence-`) && file.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right))
        .map(async (file) =>
          StoredEvidenceEventSchema.parse(
            JSON.parse(await readFile(path.join(this.#eventsDirectory(sessionId), file), "utf8")),
          ),
        ),
    );
    return StoredCheckpointSchema.parse({
      ...checkpoint,
      evidence: [...checkpoint.evidence, ...evidenceEvents.map((event) => event.evidence)],
    });
  }

  async listCheckpoints(sessionId: string): Promise<StoredCheckpoint[]> {
    const manifest = await this.readManifest(sessionId);
    return Promise.all(
      manifest.checkpointIds.map((checkpointId) =>
        this.readCheckpoint(sessionId, checkpointId),
      ),
    );
  }

  async addEvidence(
    sessionId: string,
    checkpointId: string,
    evidence: ExperimentEvidence,
  ): Promise<StoredCheckpoint> {
    await this.assertLease(sessionId);
    const checkpoint = await this.readCheckpoint(sessionId, checkpointId);
    const updated = StoredCheckpointSchema.parse({
      ...checkpoint,
      evidence: [...checkpoint.evidence, evidence],
    });
    await writeAtomic(
      this.#evidenceEventPath(sessionId, checkpoint.sequence, checkpoint.checkpointId, evidence.evidenceId),
      `${JSON.stringify({ type: "evidence", checkpointId, evidence }, null, 2)}\n`,
    );
    const manifest = await this.readManifest(sessionId);
    await this.#writeManifest({ ...manifest, updatedAt: this.#now().toISOString() });
    return updated;
  }

  async setAcceptedCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<ExperimentManifest> {
    await this.assertLease(sessionId);
    const manifest = await this.readManifest(sessionId);
    if (!manifest.checkpointIds.includes(checkpointId)) {
      throw new Error("Accepted checkpoint must belong to the experiment.");
    }
    const updated = {
      ...manifest,
      acceptedCheckpointId: checkpointId,
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    return updated;
  }

  async clearAcceptedCheckpoint(sessionId: string): Promise<ExperimentManifest> {
    const manifest = await this.readManifest(sessionId);
    const updated = {
      ...manifest,
      acceptedCheckpointId: null,
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    return updated;
  }

  async setLifecycle(
    sessionId: string,
    lifecycle: "finalized" | "abandoned",
  ): Promise<ExperimentManifest> {
    await this.assertLease(sessionId);
    const manifest = await this.readManifest(sessionId);
    const updated = {
      ...manifest,
      lifecycle,
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    await this.releaseLease(sessionId);
    return updated;
  }

  async setManagedLifecycle(
    sessionId: string,
    lifecycle: "finalized" | "abandoned",
  ): Promise<ExperimentManifest> {
    const manifest = await this.readManifest(sessionId);
    if (manifest.mode !== "worktree") {
      throw new Error("Controlled lifecycle updates belong only to managed experiments.");
    }
    const updated = {
      ...manifest,
      lifecycle,
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    await this.releaseLease(sessionId);
    return updated;
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<ExperimentManifest> {
    const manifest = await this.readManifest(sessionId);
    const updated = {
      ...manifest,
      pinned,
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    return updated;
  }

  async writeManagedMetadata(
    sessionId: string,
    metadata: ManagedExperimentMetadata,
  ): Promise<ManagedExperimentMetadata> {
    const manifest = await this.readManifest(sessionId);
    if (manifest.mode !== "worktree") {
      throw new Error("Managed metadata belongs only to worktree experiments.");
    }
    const parsed = ManagedExperimentMetadataSchema.parse(metadata);
    await writeAtomic(this.#managedMetadataPath(sessionId), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async readManagedMetadata(sessionId: string): Promise<ManagedExperimentMetadata> {
    assertUuid(sessionId);
    return ManagedExperimentMetadataSchema.parse(
      JSON.parse(await readFile(this.#managedMetadataPath(sessionId), "utf8")),
    );
  }

  async updateManagedMetadata(
    sessionId: string,
    update: Partial<{
      baseHead: string;
      experimentHead: string;
      acceptedCommit: string | null;
      formalCommit: string | null;
      state: z.infer<typeof ManagedExperimentStateSchema>;
      syncTargetHead: string | null;
    }>,
  ): Promise<ManagedExperimentMetadata> {
    const current = await this.readManagedMetadata(sessionId);
    return this.writeManagedMetadata(sessionId, { ...current, ...update });
  }

  async addWarning(
    sessionId: string,
    warning: string,
    markCoveragePartial = true,
  ): Promise<ExperimentManifest> {
    await this.assertLease(sessionId);
    const manifest = await this.readManifest(sessionId);
    if (manifest.warnings.includes(warning)) {
      return manifest;
    }
    const updated: ExperimentManifest = {
      ...manifest,
      health: markCoveragePartial ? "partial" : manifest.health,
      warnings: [...manifest.warnings, warning],
      updatedAt: this.#now().toISOString(),
    };
    await this.#writeManifest(updated);
    return updated;
  }

  async putBlob(text: string): Promise<{ sha256: string; storedBytes: number; created: boolean }> {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_EXPERIMENT_BLOB_BYTES) {
      throw new Error("Experiment document exceeds the snapshot size limit.");
    }
    if (bytes.includes(0)) {
      throw new Error("Binary documents cannot be stored in experiment history.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const blobPath = this.#blobPath(sha256);
    try {
      await stat(blobPath);
      return { sha256, storedBytes: 0, created: false };
    } catch {
      // Continue with immutable blob creation.
    }
    const compressed = await gzipAsync(bytes);
    await mkdir(path.dirname(blobPath), { recursive: true });
    try {
      const handle = await open(blobPath, "wx", 0o600);
      try {
        await handle.writeFile(compressed);
      } finally {
        await handle.close();
      }
      return { sha256, storedBytes: compressed.length, created: true };
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return { sha256, storedBytes: 0, created: false };
      }
      throw error;
    }
  }

  async readBlob(sha256: string): Promise<string> {
    ContentSha256Schema.parse(sha256);
    return Buffer.from(await gunzipAsync(await readFile(this.#blobPath(sha256)))).toString("utf8");
  }

  async addStorageBytes(sessionId: string, addedBytes: number): Promise<void> {
    if (addedBytes === 0) {
      return;
    }
    const manifest = await this.readManifest(sessionId);
    await this.#writeManifest({
      ...manifest,
      storageBytes: manifest.storageBytes + addedBytes,
      updatedAt: this.#now().toISOString(),
    });
  }

  async acquireLease(sessionId: string): Promise<void> {
    assertUuid(sessionId);
    await mkdir(this.#leasesDirectory, { recursive: true });
    const leasePath = this.#leasePath(sessionId);
    const lease = {
      sessionId,
      ownerInstanceId: this.#instanceId,
      updatedAt: this.#now().toISOString(),
    };
    try {
      const handle = await open(leasePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    const existing = await this.#readLease(sessionId);
    const stale = this.#now().getTime() - Date.parse(existing.updatedAt) > EXPERIMENT_LEASE_STALE_MS;
    if (existing.ownerInstanceId !== this.#instanceId && !stale) {
      throw new Error("Experiment is owned by another live VS Code instance.");
    }
    await writeAtomic(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
  }

  async refreshLease(sessionId: string): Promise<void> {
    await this.assertLease(sessionId);
    const lease = {
      sessionId,
      ownerInstanceId: this.#instanceId,
      updatedAt: this.#now().toISOString(),
    };
    await writeAtomic(this.#leasePath(sessionId), `${JSON.stringify(lease, null, 2)}\n`);
  }

  async assertLease(sessionId: string): Promise<void> {
    const lease = await this.#readLease(sessionId);
    if (lease.ownerInstanceId !== this.#instanceId) {
      throw new Error("Experiment is owned by another VS Code instance.");
    }
    if (this.#now().getTime() - Date.parse(lease.updatedAt) > EXPERIMENT_LEASE_STALE_MS) {
      throw new Error("Experiment lease has expired.");
    }
  }

  async releaseLease(sessionId: string): Promise<void> {
    try {
      const lease = await this.#readLease(sessionId);
      if (lease.ownerInstanceId === this.#instanceId) {
        await rm(this.#leasePath(sessionId), { force: true });
      }
    } catch {
      // Releasing an already absent or corrupt lease is harmless.
    }
  }

  async deleteExperiment(sessionId: string): Promise<void> {
    assertUuid(sessionId);
    await this.releaseLease(sessionId);
    await rm(this.#sessionDirectory(sessionId), { recursive: true, force: true });
    await this.collectUnreferencedBlobs();
  }

  async collectUnreferencedBlobs(): Promise<void> {
    const referenced = new Set<string>();
    for (const manifest of await this.listManifests()) {
      try {
        for (const checkpoint of await this.listCheckpoints(manifest.sessionId)) {
          for (const document of checkpoint.documents) {
            if (document.blobSha256) {
              referenced.add(document.blobSha256);
            }
          }
        }
      } catch {
        // Preserve all blobs when any session cannot be read safely.
        return;
      }
    }

    for (const prefix of await safeReadDirectories(this.#blobsDirectory)) {
      const prefixDirectory = path.join(this.#blobsDirectory, prefix);
      for (const file of await safeReadFiles(prefixDirectory)) {
        const sha256 = file.endsWith(".gz") ? file.slice(0, -3) : "";
        if (ContentSha256Schema.safeParse(sha256).success && !referenced.has(sha256)) {
          await rm(path.join(prefixDirectory, file), { force: true });
        }
      }
    }
  }

  async enforceRetention(): Promise<void> {
    const manifests = await this.listManifests();
    let totalBytes = manifests.reduce((total, manifest) => total + manifest.storageBytes, 0);
    const cutoff = this.#now().getTime() - this.#retentionDays * 24 * 60 * 60 * 1_000;
    const eligible = manifests
      .filter(
        (manifest) =>
          manifest.lifecycle !== "active" &&
          manifest.health !== "corrupt" &&
          !manifest.pinned,
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    for (const manifest of eligible) {
      const expired = Date.parse(manifest.updatedAt) < cutoff;
      if (!expired && totalBytes <= this.#storageLimitBytes) {
        continue;
      }
      totalBytes -= manifest.storageBytes;
      await this.deleteExperiment(manifest.sessionId);
    }
  }

  async getStats(): Promise<ExperimentStoreStats> {
    await this.#recoverSessions();
    const manifests = await this.listManifests();
    const sessionDirectories = (await safeReadDirectories(this.#sessionsDirectory)).filter(
      (name) => ExperimentIdSchema.safeParse(name).success,
    );
    const unreadableCount = Math.max(0, sessionDirectories.length - manifests.length);
    return {
      sessionCount: sessionDirectories.length,
      activeCount: manifests.filter((manifest) => manifest.lifecycle === "active").length,
      corruptCount:
        manifests.filter((manifest) => manifest.health === "corrupt").length + unreadableCount,
      storageBytes: manifests.reduce((total, manifest) => total + manifest.storageBytes, 0),
    };
  }

  async toExperimentInfo(manifest: ExperimentManifest): Promise<ExperimentInfo> {
    const managed = manifest.mode === "worktree" ? await this.readManagedMetadata(manifest.sessionId) : null;
    return ExperimentInfoSchema.parse({
      instanceId: this.#instanceId,
      sessionId: manifest.sessionId,
      mode: manifest.mode,
      lifecycle: manifest.lifecycle,
      health: manifest.health,
      title: manifest.title,
      rootUri: manifest.rootUri,
      baseRevision: manifest.baseRevision,
      branch: manifest.branch,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      currentCheckpointId: manifest.currentCheckpointId,
      acceptedCheckpointId: manifest.acceptedCheckpointId,
      pinned: manifest.pinned,
      storageBytes: manifest.storageBytes,
      warnings: manifest.warnings,
      managed: managed
        ? {
            targetBranch: managed.targetBranch,
            baseHead: managed.baseHead,
            experimentBranch: managed.experimentBranch,
            experimentHead: managed.experimentHead,
            acceptedCommit: managed.acceptedCommit,
            formalCommit: managed.formalCommit,
            state: managed.state,
          }
        : null,
    });
  }

  async #readLease(sessionId: string): Promise<z.infer<typeof LeaseSchema>> {
    const value = JSON.parse(await readFile(this.#leasePath(sessionId), "utf8"));
    return LeaseSchema.parse(value);
  }

  async #writeManifest(manifest: ExperimentManifest): Promise<void> {
    ExperimentManifestSchema.parse(manifest);
    await mkdir(this.#sessionDirectory(manifest.sessionId), { recursive: true });
    await writeAtomic(this.#manifestPath(manifest.sessionId), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  #sessionDirectory(sessionId: string): string {
    return path.join(this.#sessionsDirectory, sessionId);
  }

  #eventsDirectory(sessionId: string): string {
    return path.join(this.#sessionDirectory(sessionId), "events");
  }

  #manifestPath(sessionId: string): string {
    return path.join(this.#sessionDirectory(sessionId), "manifest.json");
  }

  #managedMetadataPath(sessionId: string): string {
    return path.join(this.#sessionDirectory(sessionId), "managed.json");
  }

  #eventPath(sessionId: string, sequence: number, checkpointId: string): string {
    return path.join(
      this.#eventsDirectory(sessionId),
      `${String(sequence).padStart(8, "0")}-${checkpointId}.json`,
    );
  }

  #evidenceEventPath(
    sessionId: string,
    sequence: number,
    checkpointId: string,
    evidenceId: string,
  ): string {
    return path.join(
      this.#eventsDirectory(sessionId),
      `${String(sequence).padStart(8, "0")}-${checkpointId}-evidence-${evidenceId}.json`,
    );
  }

  #leasePath(sessionId: string): string {
    return path.join(this.#leasesDirectory, `${sessionId}.json`);
  }

  #blobPath(sha256: string): string {
    return path.join(this.#blobsDirectory, sha256.slice(0, 2), `${sha256}.gz`);
  }

  async #recoverSessions(): Promise<void> {
    const validatedBlobs = new Set<string>();
    for (const sessionId of await safeReadDirectories(this.#sessionsDirectory)) {
      if (!ExperimentIdSchema.safeParse(sessionId).success) {
        continue;
      }
      let manifest: ExperimentManifest;
      try {
        manifest = await this.readManifest(sessionId);
      } catch {
        continue;
      }
      try {
        for (const checkpointId of manifest.checkpointIds) {
          const checkpoint = await this.readCheckpoint(sessionId, checkpointId);
          for (const document of checkpoint.documents) {
            if (document.blobSha256 && !validatedBlobs.has(document.blobSha256)) {
              await this.readBlob(document.blobSha256);
              validatedBlobs.add(document.blobSha256);
            }
          }
        }
      } catch {
        if (manifest.health !== "corrupt") {
          const warning = "Experiment storage validation failed; the session requires explicit review.";
          await this.#writeManifest({
            ...manifest,
            health: "corrupt",
            warnings: manifest.warnings.includes(warning)
              ? manifest.warnings
              : [...manifest.warnings, warning],
            updatedAt: this.#now().toISOString(),
          });
        }
      }
    }
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const normalizedPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const previous = atomicWriteQueues.get(normalizedPath) ?? Promise.resolve();
  const operation = previous.then(
    () => writeAtomicNow(filePath, contents),
    () => writeAtomicNow(filePath, contents),
  );
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  atomicWriteQueues.set(normalizedPath, tail);
  void tail.then(() => {
    if (atomicWriteQueues.get(normalizedPath) === tail) {
      atomicWriteQueues.delete(normalizedPath);
    }
  });
  return operation;
}

async function serializeManifestMutation<Result>(
  filePath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const resolvedPath = path.resolve(filePath);
  const normalizedPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const previous = manifestMutationQueues.get(normalizedPath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  manifestMutationQueues.set(normalizedPath, tail);
  void tail.then(() => {
    if (manifestMutationQueues.get(normalizedPath) === tail) {
      manifestMutationQueues.delete(normalizedPath);
    }
  });
  return result;
}

async function writeAtomicNow(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporaryPath, filePath);
        break;
      } catch (error) {
        const delay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isRetryableAtomicRenameError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertUuid(value: string): void {
  ExperimentIdSchema.parse(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

async function safeReadDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function safeReadFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
