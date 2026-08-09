import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import * as vscode from "vscode";

import {
  BridgeError,
  type ExperimentCheckpointsResult,
  type ExperimentEvidence,
  type ExperimentInfo,
  type ListExperimentCheckpointsParams,
  type RecordExperimentEvidenceParams,
} from "@vscode-agent-bridge/protocol";

import {
  ExperimentStore,
  MAX_EXPERIMENT_BLOB_BYTES,
  type ExperimentManifest,
  type ManagedExperimentMetadata,
  type StoredCheckpoint,
  type StoredDocument,
} from "./experiment-store.js";
import { ReadOnlyGitBaseline, type GitBaseline } from "./git-baseline.js";

const MANUAL_CAPTURE_IDLE_MS = 3_000;
const GIT_POLL_INTERVAL_MS = 5_000;
const LEASE_REFRESH_INTERVAL_MS = 5_000;
const DIAGNOSTIC_SETTLE_MS = 750;

interface ActiveExperiment {
  manifest: ExperimentManifest;
  readonly root: vscode.Uri;
  readonly documents: Map<string, StoredDocument>;
  readonly git: ReadOnlyGitBaseline | null;
  gitHead: string | null;
}

interface ResolvedCheckpointDocument {
  readonly state: StoredDocument;
  readonly baselineText: string | null;
}

export interface StartExperimentOptions {
  readonly title: string;
  readonly root: vscode.Uri;
}

export interface CreateManagedExperimentOptions {
  readonly sessionId: string;
  readonly title: string;
  readonly worktreeRoot: vscode.Uri;
  readonly metadata: ManagedExperimentMetadata;
}

export class ExperimentManager implements vscode.Disposable {
  readonly #instanceId: string;
  readonly #output: vscode.LogOutputChannel;
  readonly #store: ExperimentStore;
  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly #disposables: vscode.Disposable[] = [];
  readonly #pendingManualUris = new Set<string>();
  readonly #pendingExternalUris = new Set<string>();
  #active: ActiveExperiment | undefined;
  #manualTimer: ReturnType<typeof setTimeout> | undefined;
  #externalTimer: ReturnType<typeof setTimeout> | undefined;
  #leaseTimer: ReturnType<typeof setInterval> | undefined;
  #gitTimer: ReturnType<typeof setInterval> | undefined;
  #fileWatcher: vscode.FileSystemWatcher | undefined;
  #operationQueue: Promise<void> = Promise.resolve();
  #suppressAutomaticCapture = 0;
  #disposed = false;

  readonly onDidChange = this.#changeEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    instanceId: string,
    output: vscode.LogOutputChannel,
  ) {
    this.#instanceId = instanceId;
    this.#output = output;
    this.#store = new ExperimentStore(
      path.join(context.globalStorageUri.fsPath, "experiments", "v1"),
      instanceId,
    );
  }

  get activeSessionId(): string | undefined {
    return this.#active?.manifest.sessionId;
  }

  async initialize(): Promise<void> {
    await this.#store.initialize();
    await this.#store.enforceRetention();
    this.#registerDocumentListeners();
    await this.#resumeMatchingExperiment();
  }

  async startWorkspaceExperiment(options: StartExperimentOptions): Promise<ExperimentInfo> {
    this.#assertMutationAllowed();
    if (this.#active) {
      throw new BridgeError(
        "EXPERIMENT_ALREADY_ACTIVE",
        "This VS Code window already has an active experiment.",
      );
    }
    if (options.root.scheme !== "file") {
      throw new BridgeError(
        "UNSUPPORTED_DOCUMENT_SCHEME",
        "Experiments require a local file workspace folder.",
      );
    }

    const inspected = await ReadOnlyGitBaseline.inspect(options.root.fsPath);
    const git = inspected?.git ?? null;
    const baseline = inspected?.baseline ?? null;
    const warnings: string[] = [];
    if (!baseline?.head) {
      warnings.push(
        baseline
          ? "The Git repository has no HEAD commit; recovery coverage is limited."
          : "No Git repository was found; only managed text documents are fully captured.",
      );
    }
    const baselineDocuments = await this.#captureBaselineDocuments(
      options.root,
      git,
      baseline,
      warnings,
    );
    const created = await this.#store.createExperiment({
      mode: "workspace",
      title: options.title,
      rootUri: options.root.toString(true),
      workspaceIdentity: workspaceIdentity(options.root),
      baseRevision: baseline?.head ?? null,
      branch: baseline?.branch ?? null,
      health: baseline?.head ? "complete" : "partial",
      warnings,
      baselineDocuments: [...baselineDocuments.values()],
    });
    const storedBytes = await this.#storedBytesForDocuments(baselineDocuments.values());
    await this.#store.addStorageBytes(created.sessionId, storedBytes);
    const manifest = await this.#store.readManifest(created.sessionId);
    this.#active = {
      manifest,
      root: options.root,
      documents: baselineDocuments,
      git,
      gitHead: baseline?.head ?? null,
    };
    this.#startActiveMonitoring();
    this.#changeEmitter.fire();
    return this.#store.toExperimentInfo(manifest);
  }

  async createManagedExperimentSession(
    options: CreateManagedExperimentOptions,
  ): Promise<ExperimentInfo> {
    this.#assertMutationAllowed();
    if (this.#active) {
      throw new BridgeError(
        "EXPERIMENT_ALREADY_ACTIVE",
        "Finish the active experiment before creating a managed worktree experiment.",
      );
    }
    const created = await this.#store.createExperiment({
      sessionId: options.sessionId,
      mode: "worktree",
      title: options.title,
      rootUri: options.worktreeRoot.toString(true),
      workspaceIdentity: workspaceIdentity(options.worktreeRoot),
      baseRevision: options.metadata.baseHead,
      branch: options.metadata.experimentBranch,
      health: "complete",
    });
    await this.#store.writeManagedMetadata(created.sessionId, options.metadata);
    await this.#store.releaseLease(created.sessionId);
    return this.#store.toExperimentInfo(await this.#store.readManifest(created.sessionId));
  }

  async getActiveExperiment(): Promise<ExperimentInfo> {
    const active = this.#requireActive();
    active.manifest = await this.#store.readManifest(active.manifest.sessionId);
    return this.#store.toExperimentInfo(active.manifest);
  }

  async listCheckpoints(
    params: ListExperimentCheckpointsParams,
  ): Promise<ExperimentCheckpointsResult> {
    const active = this.#requireActive(params.sessionId);
    const checkpoints = await this.#store.listCheckpoints(active.manifest.sessionId);
    const visible = checkpoints.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      sessionId: active.manifest.sessionId,
      checkpoints: visible.map(toPublicCheckpoint),
      returnedCount: visible.length,
      totalCount: checkpoints.length,
      truncated: params.offset + visible.length < checkpoints.length,
    };
  }

  async createExplicitCheckpoint(summary = "Explicit experiment checkpoint"): Promise<string> {
    const active = this.#requireActive();
    await this.flushPendingCaptures();
    return this.#enqueue(async () => {
      await this.#reconcileGitDocuments(active);
      return this.#appendCheckpoint(active, "explicit", summary, true);
    });
  }

  async captureAfterAgentApply(
    sessionId: string,
    summary: string,
    uris: readonly vscode.Uri[],
  ): Promise<string> {
    const active = this.#requireActive(sessionId);
    return this.#enqueue(async () => {
      await this.#captureUris(active, uris);
      return this.#appendCheckpoint(active, "agentApply", summary, true);
    });
  }

  async applyGuardedWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    this.#assertMutationAllowed();
    this.#requireActive();
    this.#suppressAutomaticCapture += 1;
    try {
      return await vscode.workspace.applyEdit(edit);
    } finally {
      this.#suppressAutomaticCapture -= 1;
    }
  }

  async recordClientEvidence(params: RecordExperimentEvidenceParams): Promise<ExperimentEvidence> {
    const active = this.#requireActive(params.sessionId);
    const evidence: ExperimentEvidence = {
      evidenceId: randomUUID(),
      kind: params.kind,
      status: params.status,
      source: "client-reported",
      summary: params.summary,
      createdAt: new Date().toISOString(),
    };
    await this.#store.addEvidence(active.manifest.sessionId, params.checkpointId, evidence);
    active.manifest = await this.#store.readManifest(active.manifest.sessionId);
    this.#changeEmitter.fire();
    return evidence;
  }

  async markAccepted(checkpointId: string): Promise<void> {
    const active = this.#requireActive();
    await this.flushPendingCaptures();
    if (active.manifest.mode === "worktree") {
      const checkpoint = await this.#store.readCheckpoint(active.manifest.sessionId, checkpointId);
      if (!checkpoint.gitCommit) {
        throw new BridgeError(
          "ACCEPTED_COMMIT_REQUIRED",
          "Managed experiments can accept only checkpoints backed by a Git commit.",
        );
      }
      await this.#store.updateManagedMetadata(active.manifest.sessionId, {
        acceptedCommit: checkpoint.gitCommit,
      });
    }
    active.manifest = await this.#store.setAcceptedCheckpoint(
      active.manifest.sessionId,
      checkpointId,
    );
    this.#changeEmitter.fire();
  }

  async restoreAccepted(): Promise<void> {
    this.#assertMutationAllowed();
    const active = this.#requireActive();
    await this.flushPendingCaptures();
    const acceptedId = active.manifest.acceptedCheckpointId;
    if (!acceptedId) {
      throw new BridgeError("INVALID_REQUEST", "No experiment checkpoint has been accepted.");
    }
    const accepted = await this.#store.readCheckpoint(active.manifest.sessionId, acceptedId);
    await this.#reconcileGitDocuments(active);
    const resolvedAccepted = await this.#resolveCheckpointDocuments(active, accepted.documents);
    if (resolvedAccepted.some(({ state }) => !state.exists || (!state.blobSha256 && !state.contentSha256))) {
      throw new BridgeError(
        "SESSION_COVERAGE_INCOMPLETE",
        "The accepted checkpoint contains resource-level changes that v0.3 cannot restore safely.",
      );
    }

    await this.createExplicitCheckpoint("Safety checkpoint before restoring accepted candidate");
    const edit = new vscode.WorkspaceEdit();
    for (const { state, baselineText } of resolvedAccepted) {
      const uri = vscode.Uri.parse(state.uri, true);
      if (uri.scheme !== "file" && uri.scheme !== "untitled") {
        throw new BridgeError(
          "UNSUPPORTED_DOCUMENT_SCHEME",
          "Accepted candidate contains an unsupported document scheme.",
        );
      }
      const document = await resolveExistingDocument(uri);
      const text = baselineText ?? await this.#store.readBlob(state.blobSha256!);
      edit.replace(uri, fullDocumentRange(document), text);
    }

    this.#suppressAutomaticCapture += 1;
    try {
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new BridgeError("INTERNAL_ERROR", "VS Code refused to restore the accepted candidate.");
      }
    } finally {
      this.#suppressAutomaticCapture -= 1;
    }
    await this.#captureUris(
      active,
      resolvedAccepted.map(({ state }) => vscode.Uri.parse(state.uri, true)),
    );
    await this.#appendCheckpoint(active, "restore", "Restored accepted candidate", true);
  }

  async finalize(): Promise<void> {
    await this.flushPendingCaptures();
    await this.#enqueue(async () => {
      const active = this.#requireActive();
      await this.#reconcileGitDocuments(active);
      const acceptedId = active.manifest.acceptedCheckpointId;
      if (!acceptedId) {
        throw new BridgeError("INVALID_REQUEST", "No experiment checkpoint has been accepted.");
      }
      const accepted = await this.#store.readCheckpoint(active.manifest.sessionId, acceptedId);
      await this.#refreshCurrentDocuments(active);
      const resolvedAccepted = await this.#resolveCheckpointDocuments(active, accepted.documents);
      if (!sameDocumentContent(resolvedAccepted.map(({ state }) => state), active.documents.values())) {
        throw new BridgeError(
          "STALE_CHANGE_SET",
          "The current workspace no longer matches the accepted checkpoint. Restore it explicitly first.",
        );
      }
      const dirty = vscode.workspace.textDocuments.some(
        (document) => document.isDirty && isUriWithin(active.root, document.uri),
      );
      if (dirty) {
        throw new BridgeError(
          "INVALID_REQUEST",
          "Save all experiment documents before finalizing. The extension will not save automatically.",
        );
      }
      active.manifest = await this.#store.setLifecycle(active.manifest.sessionId, "finalized");
      this.#stopActiveMonitoring();
      this.#active = undefined;
      this.#changeEmitter.fire();
    });
  }

  async abandon(): Promise<void> {
    await this.flushPendingCaptures();
    await this.#enqueue(async () => {
      const active = this.#requireActive();
      active.manifest = await this.#store.setLifecycle(active.manifest.sessionId, "abandoned");
      this.#stopActiveMonitoring();
      this.#active = undefined;
      this.#changeEmitter.fire();
    });
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await this.#store.setPinned(sessionId, pinned);
    if (this.#active?.manifest.sessionId === sessionId) {
      this.#active.manifest = await this.#store.readManifest(sessionId);
    }
    this.#changeEmitter.fire();
  }

  async deleteExperiment(sessionId: string): Promise<void> {
    if (this.#active?.manifest.sessionId === sessionId) {
      throw new BridgeError("INVALID_REQUEST", "Abandon the active experiment before deleting it.");
    }
    await this.#store.deleteExperiment(sessionId);
    this.#changeEmitter.fire();
  }

  async listAllManifests(): Promise<ExperimentManifest[]> {
    return this.#store.listManifests();
  }

  async readCheckpoint(sessionId: string, checkpointId: string): Promise<StoredCheckpoint> {
    return this.#store.readCheckpoint(sessionId, checkpointId);
  }

  async readCheckpointList(sessionId: string): Promise<StoredCheckpoint[]> {
    return this.#store.listCheckpoints(sessionId);
  }

  async readSnapshotText(
    sessionId: string,
    checkpointId: string,
    documentUri: string,
  ): Promise<string> {
    const checkpoint = await this.#store.readCheckpoint(sessionId, checkpointId);
    const document = checkpoint.documents.find((item) => item.uri === documentUri);
    if (!document?.blobSha256) {
      throw new BridgeError("DOCUMENT_NOT_FOUND", "Snapshot document was not found.");
    }
    return this.#store.readBlob(document.blobSha256);
  }

  async getStoreStats(): Promise<Awaited<ReturnType<ExperimentStore["getStats"]>>> {
    return this.#store.getStats();
  }

  async readManagedMetadata(sessionId: string): Promise<ManagedExperimentMetadata> {
    return this.#store.readManagedMetadata(sessionId);
  }

  async updateManagedMetadata(
    sessionId: string,
    update: Parameters<ExperimentStore["updateManagedMetadata"]>[1],
  ): Promise<ManagedExperimentMetadata> {
    return this.#store.updateManagedMetadata(sessionId, update);
  }

  async clearManagedAcceptedCandidate(sessionId: string): Promise<void> {
    await Promise.all([
      this.#store.clearAcceptedCheckpoint(sessionId),
      this.#store.updateManagedMetadata(sessionId, { acceptedCommit: null }),
    ]);
    if (this.#active?.manifest.sessionId === sessionId) {
      this.#active.manifest = await this.#store.readManifest(sessionId);
    }
    this.#changeEmitter.fire();
  }

  async setManagedLifecycle(
    sessionId: string,
    lifecycle: "finalized" | "abandoned",
  ): Promise<void> {
    await this.#store.setManagedLifecycle(sessionId, lifecycle);
    if (this.#active?.manifest.sessionId === sessionId) {
      this.#stopActiveMonitoring();
      this.#active = undefined;
    }
    this.#changeEmitter.fire();
  }

  async captureGitHeadNow(): Promise<void> {
    await this.#pollGitHead();
  }

  async flushPendingCaptures(): Promise<void> {
    if (this.#manualTimer) {
      clearTimeout(this.#manualTimer);
      this.#manualTimer = undefined;
    }
    if (this.#externalTimer) {
      clearTimeout(this.#externalTimer);
      this.#externalTimer = undefined;
    }
    const manualUris = drainSet(this.#pendingManualUris).map((value) => vscode.Uri.parse(value, true));
    const externalUris = drainSet(this.#pendingExternalUris).map((value) => vscode.Uri.parse(value, true));
    if (manualUris.length > 0) {
      await this.#enqueue(() => this.#captureCheckpoint("manualEdit", "Manual editor changes", manualUris));
    }
    if (externalUris.length > 0) {
      await this.#enqueue(() =>
        this.#captureCheckpoint("externalChange", "External workspace changes", externalUris),
      );
    }
    await this.#operationQueue;
  }

  async disposeAsync(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    await this.flushPendingCaptures().catch(() => undefined);
    const sessionId = this.#active?.manifest.sessionId;
    this.#stopActiveMonitoring();
    if (sessionId) {
      await this.#store.releaseLease(sessionId);
    }
    for (const disposable of this.#disposables) {
      disposable.dispose();
    }
    this.#changeEmitter.dispose();
  }

  dispose(): void {
    void this.disposeAsync();
  }

  async #resumeMatchingExperiment(): Promise<void> {
    const roots = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true)),
    );
    const candidate = (await this.#store.listManifests()).find(
      (manifest) =>
        (manifest.mode === "workspace" || manifest.mode === "worktree") &&
        manifest.lifecycle === "active" &&
        roots.has(manifest.rootUri),
    );
    if (!candidate) {
      return;
    }
    try {
      await this.#store.acquireLease(candidate.sessionId);
      const checkpoint = candidate.currentCheckpointId
        ? await this.#store.readCheckpoint(candidate.sessionId, candidate.currentCheckpointId)
        : undefined;
      const inspected = await ReadOnlyGitBaseline.inspect(vscode.Uri.parse(candidate.rootUri).fsPath);
      this.#active = {
        manifest: candidate,
        root: vscode.Uri.parse(candidate.rootUri, true),
        documents: new Map((checkpoint?.documents ?? []).map((item) => [item.uri, item])),
        git: inspected?.git ?? null,
        gitHead: await inspected?.git.getHead() ?? null,
      };
      this.#startActiveMonitoring();
      this.#output.info(`Resumed experiment session ${candidate.sessionId}.`);
      this.#changeEmitter.fire();
    } catch {
      this.#output.warn("An active experiment exists but is still leased by another VS Code window.");
    }
  }

  #registerDocumentListeners(): void {
    this.#disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          this.#suppressAutomaticCapture > 0 ||
          !this.#active ||
          !isUriWithin(this.#active.root, event.document.uri)
        ) {
          return;
        }
        this.#pendingManualUris.add(event.document.uri.toString(true));
        if (this.#manualTimer) {
          clearTimeout(this.#manualTimer);
        }
        this.#manualTimer = setTimeout(() => {
          this.#manualTimer = undefined;
          const uris = drainSet(this.#pendingManualUris).map((value) => vscode.Uri.parse(value, true));
          if (uris.length > 0) {
            void this.#enqueue(() =>
              this.#captureCheckpoint("manualEdit", "Manual editor changes", uris),
            );
          }
        }, MANUAL_CAPTURE_IDLE_MS);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.#active || !isUriWithin(this.#active.root, document.uri)) {
          return;
        }
        this.#pendingManualUris.delete(document.uri.toString(true));
        void this.#enqueue(() => this.#captureCheckpoint("save", "Document saved", [document.uri]));
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (!this.#active || !isUriWithin(this.#active.root, document.uri)) {
          return;
        }
        this.#pendingManualUris.delete(document.uri.toString(true));
        void this.#enqueue(() =>
          this.#captureCheckpoint("explicit", "Document closed", [document.uri]),
        );
      }),
    );
  }

  #startActiveMonitoring(): void {
    this.#stopActiveMonitoring();
    const active = this.#active;
    if (!active) {
      return;
    }
    this.#leaseTimer = setInterval(() => {
      void this.#enqueue(() => this.#refreshActiveLease(active)).catch((error: unknown) => {
        this.#output.error("Experiment lease refresh failed.", error);
      });
    }, LEASE_REFRESH_INTERVAL_MS);
    this.#gitTimer = setInterval(() => void this.#pollGitHead(), GIT_POLL_INTERVAL_MS);
    this.#fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(active.root, "**/*"),
    );
    this.#disposables.push(this.#fileWatcher);
    const schedule = (uri: vscode.Uri, resourceChange: boolean): void => {
      if (!this.#active || uri.path.includes("/.git/")) {
        return;
      }
      this.#pendingExternalUris.add(uri.toString(true));
      if (resourceChange) {
        void this.#store
          .addWarning(
            this.#active.manifest.sessionId,
            "Resource-level changes were observed; v0.3 whole-session restore is limited.",
          )
          .then((manifest) => {
            if (this.#active) {
              this.#active.manifest = manifest;
              this.#changeEmitter.fire();
            }
          })
          .catch(() => undefined);
      }
      if (this.#externalTimer) {
        clearTimeout(this.#externalTimer);
      }
      this.#externalTimer = setTimeout(() => {
        this.#externalTimer = undefined;
        const uris = drainSet(this.#pendingExternalUris).map((value) => vscode.Uri.parse(value, true));
        if (uris.length > 0) {
          void this.#enqueue(() =>
            this.#captureCheckpoint("externalChange", "External workspace changes", uris),
          );
        }
      }, 500);
    };
    this.#fileWatcher.onDidChange((uri) => schedule(uri, false));
    this.#fileWatcher.onDidCreate((uri) => schedule(uri, true));
    this.#fileWatcher.onDidDelete((uri) => schedule(uri, true));
  }

  #stopActiveMonitoring(): void {
    if (this.#leaseTimer) {
      clearInterval(this.#leaseTimer);
      this.#leaseTimer = undefined;
    }
    if (this.#gitTimer) {
      clearInterval(this.#gitTimer);
      this.#gitTimer = undefined;
    }
    this.#fileWatcher?.dispose();
    this.#fileWatcher = undefined;
  }

  async #captureBaselineDocuments(
    root: vscode.Uri,
    git: ReadOnlyGitBaseline | null,
    baseline: GitBaseline | null,
    warnings: string[],
  ): Promise<Map<string, StoredDocument>> {
    const documents = new Map<string, StoredDocument>();
    for (const relativePath of baseline?.dirtyPaths ?? []) {
      const uri = vscode.Uri.file(git!.resolvePath(relativePath));
      if (!isUriWithin(root, uri)) {
        continue;
      }
      try {
        const state = await this.#snapshotUri(uri);
        documents.set(state.uri, state);
      } catch {
        warnings.push(`A dirty Git path could not be snapshotted: ${relativePath}`);
      }
    }
    for (const document of vscode.workspace.textDocuments) {
      if (!isUriWithin(root, document.uri) || (!document.isDirty && document.uri.scheme !== "untitled")) {
        continue;
      }
      try {
        const state = await this.#snapshotDocument(document);
        documents.set(state.uri, state);
      } catch {
        warnings.push("An open document exceeded the text snapshot boundary.");
      }
    }
    return documents;
  }

  async #captureCheckpoint(
    source: StoredCheckpoint["source"],
    summary: string,
    uris: readonly vscode.Uri[],
  ): Promise<string> {
    const active = this.#requireActive();
    const changed = await this.#captureUris(active, uris);
    if (!changed && source !== "explicit" && source !== "gitCommit") {
      return active.manifest.currentCheckpointId ?? "";
    }
    return this.#appendCheckpoint(active, source, summary, source !== "externalChange");
  }

  async #captureUris(active: ActiveExperiment, uris: readonly vscode.Uri[]): Promise<boolean> {
    let changed = false;
    let addedStorageBytes = 0;
    for (const uri of uniqueUris(uris)) {
      if (!isUriWithin(active.root, uri)) {
        continue;
      }
      let state: StoredDocument;
      try {
        state = await this.#snapshotUri(uri);
      } catch {
        active.manifest = await this.#store.addWarning(
          active.manifest.sessionId,
          "One or more documents could not be stored within the text snapshot boundary.",
        );
        continue;
      }
      const previous = active.documents.get(state.uri);
      if (!sameStoredDocument(previous, state)) {
        changed = true;
        active.documents.set(state.uri, state);
        if (state.blobSha256 && state.blobSha256 !== previous?.blobSha256) {
          const blobPathBytes = await this.#storedBytesForDocuments([state]);
          addedStorageBytes += blobPathBytes;
        }
      }
    }
    await this.#store.addStorageBytes(active.manifest.sessionId, addedStorageBytes);
    return changed;
  }

  async #appendCheckpoint(
    active: ActiveExperiment,
    source: StoredCheckpoint["source"],
    summary: string,
    coverageComplete: boolean,
    gitCommit: string | null = null,
  ): Promise<string> {
    active.manifest = await this.#store.appendCheckpoint(active.manifest.sessionId, {
      source,
      summary,
      documents: [...active.documents.values()].sort((left, right) => left.uri.localeCompare(right.uri)),
      coverageComplete: coverageComplete && active.manifest.health === "complete",
      gitCommit,
    });
    const checkpointId = active.manifest.currentCheckpointId!;
    this.#scheduleDiagnosticEvidence(active, checkpointId);
    this.#changeEmitter.fire();
    return checkpointId;
  }

  #scheduleDiagnosticEvidence(active: ActiveExperiment, checkpointId: string): void {
    setTimeout(() => {
      void this.#enqueue(() => this.#captureDiagnosticEvidence(active, checkpointId));
    }, DIAGNOSTIC_SETTLE_MS);
  }

  async #captureDiagnosticEvidence(
    active: ActiveExperiment,
    checkpointId: string,
  ): Promise<void> {
    if (this.#active?.manifest.sessionId !== active.manifest.sessionId) {
      return;
    }
    const diagnostics = [...active.documents.values()]
      .filter((document) => document.exists)
      .flatMap((document) =>
        vscode.languages.getDiagnostics(vscode.Uri.parse(document.uri, true)).slice(0, 200),
      );
    const errors = diagnostics.filter(
      (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error,
    ).length;
    const warnings = diagnostics.filter(
      (diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Warning,
    ).length;
    const evidence: ExperimentEvidence = {
      evidenceId: randomUUID(),
      kind: "diagnostics",
      status: errors === 0 ? "passed" : "failed",
      source: "automatic-diagnostics",
      summary: `Diagnostics: ${errors} error(s), ${warnings} warning(s), ${diagnostics.length} captured item(s).`,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.#store.addEvidence(active.manifest.sessionId, checkpointId, evidence);
      active.manifest = await this.#store.readManifest(active.manifest.sessionId);
      this.#changeEmitter.fire();
    } catch {
      // Evidence is supplemental and must not invalidate the checkpoint.
    }
  }

  async #snapshotUri(uri: vscode.Uri): Promise<StoredDocument> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString(true) === uri.toString(true),
    );
    if (openDocument) {
      return this.#snapshotDocument(openDocument);
    }
    if (uri.scheme !== "file") {
      throw new Error("Only open non-file documents can be snapshotted.");
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          uri: uri.toString(true),
          languageId: "plaintext",
          documentVersion: null,
          isDirty: false,
          exists: false,
          blobSha256: null,
          contentSha256: null,
        };
      }
      throw error;
    }
    if (bytes.byteLength > MAX_EXPERIMENT_BLOB_BYTES || bytes.includes(0)) {
      throw new Error("Document is binary or too large.");
    }
    return this.#storeText(uri, Buffer.from(bytes).toString("utf8"), "plaintext", null, false);
  }

  async #snapshotDocument(document: vscode.TextDocument): Promise<StoredDocument> {
    return this.#storeText(
      document.uri,
      document.getText(),
      document.languageId,
      document.version,
      document.isDirty,
    );
  }

  async #storeText(
    uri: vscode.Uri,
    text: string,
    languageId: string,
    documentVersion: number | null,
    isDirty: boolean,
  ): Promise<StoredDocument> {
    const blob = await this.#store.putBlob(text);
    return {
      uri: uri.toString(true),
      languageId,
      documentVersion,
      isDirty,
      exists: true,
      blobSha256: blob.sha256,
      contentSha256: blob.sha256,
    };
  }

  async #storedBytesForDocuments(documents: Iterable<StoredDocument>): Promise<number> {
    let total = 0;
    const seen = new Set<string>();
    for (const document of documents) {
      if (!document.blobSha256 || seen.has(document.blobSha256)) {
        continue;
      }
      seen.add(document.blobSha256);
      // Blob byte accounting is approximate and bounded; shared blobs may be counted per session.
      total += Buffer.byteLength(await this.#store.readBlob(document.blobSha256), "utf8");
    }
    return total;
  }

  async #pollGitHead(): Promise<void> {
    const active = this.#active;
    if (!active?.git) {
      return;
    }
    try {
      const head = await active.git.getHead();
      if (head && head !== active.gitHead) {
        const previousHead = active.gitHead;
        active.gitHead = head;
        let changedUris: vscode.Uri[] = [];
        let resourceChange = false;
        if (previousHead) {
          const changedPaths = await active.git.changedPaths(previousHead, head);
          changedUris = changedPaths
            .map((relativePath) => vscode.Uri.file(active.git!.resolvePath(relativePath)))
            .filter((uri) => isUriWithin(active.root, uri));
          for (const relativePath of changedPaths) {
            const [beforeText, afterText] = await Promise.all([
              active.git.readHeadText(relativePath, previousHead),
              active.git.readHeadText(relativePath, head),
            ]);
            resourceChange ||= beforeText === null || afterText === null;
          }
        }
        active.manifest = await this.#store.addWarning(
          active.manifest.sessionId,
          "Git HEAD changed during the experiment; formal repository history has changed.",
          false,
        );
        if (resourceChange) {
          active.manifest = await this.#store.addWarning(
            active.manifest.sessionId,
            "The Git commit includes a resource-level change; whole-session restore is limited.",
          );
        }
        void vscode.window.showWarningMessage(
          "Git HEAD changed during the active Agent experiment. Formal Git history is now separate from experiment checkpoints.",
        );
        await this.#enqueue(async () => {
          await this.#captureUris(active, changedUris);
          await this.#reconcileGitDocuments(active);
          await this.#appendCheckpoint(
            active,
            "gitCommit",
            "Git HEAD changed during experiment",
            !resourceChange,
            head,
          );
          if (active.manifest.mode === "worktree") {
            await this.#store.updateManagedMetadata(active.manifest.sessionId, {
              experimentHead: head,
            });
          }
        });
      }
    } catch {
      // A transient Git failure is retried on the next poll.
    }
  }

  async #refreshActiveLease(active: ActiveExperiment): Promise<void> {
    const manifest = await this.#store.readManifest(active.manifest.sessionId);
    if (manifest.lifecycle !== "active") {
      await this.#store.releaseLease(active.manifest.sessionId);
      if (this.#active?.manifest.sessionId === active.manifest.sessionId) {
        this.#stopActiveMonitoring();
        this.#active = undefined;
        this.#changeEmitter.fire();
      }
      return;
    }
    active.manifest = manifest;
    await this.#store.refreshLease(active.manifest.sessionId);
  }

  async #reconcileGitDocuments(active: ActiveExperiment): Promise<void> {
    if (!active.git) {
      return;
    }
    const uris = (await active.git.dirtyPaths())
      .map((relativePath) => vscode.Uri.file(active.git!.resolvePath(relativePath)))
      .filter((uri) => isUriWithin(active.root, uri));
    for (const state of active.documents.values()) {
      const uri = vscode.Uri.parse(state.uri, true);
      if (uri.scheme === "file") {
        uris.push(uri);
      }
    }
    await this.#captureUris(active, uris);
  }

  async #refreshCurrentDocuments(active: ActiveExperiment): Promise<void> {
    await this.#captureUris(
      active,
      [...active.documents.values()].map((document) => vscode.Uri.parse(document.uri, true)),
    );
  }

  async #resolveCheckpointDocuments(
    active: ActiveExperiment,
    checkpointDocuments: readonly StoredDocument[],
  ): Promise<ResolvedCheckpointDocument[]> {
    const resolved = new Map<string, ResolvedCheckpointDocument>(
      checkpointDocuments.map((state) => [state.uri, { state, baselineText: null }]),
    );
    for (const current of active.documents.values()) {
      if (resolved.has(current.uri)) {
        continue;
      }
      const uri = vscode.Uri.parse(current.uri, true);
      const relativePath = uri.scheme === "file" ? active.git?.relativePath(uri.fsPath) : null;
      if (!active.git || !active.manifest.baseRevision || !relativePath || !current.exists) {
        throw new BridgeError(
          "SESSION_COVERAGE_INCOMPLETE",
          "The accepted checkpoint cannot reconstruct a resource-level or non-Git change.",
        );
      }
      const baselineText = await active.git.readHeadText(relativePath, active.manifest.baseRevision);
      if (baselineText === null || Buffer.byteLength(baselineText, "utf8") > MAX_EXPERIMENT_BLOB_BYTES) {
        throw new BridgeError(
          "SESSION_COVERAGE_INCOMPLETE",
          "The accepted checkpoint cannot reconstruct a document from the fixed Git baseline.",
        );
      }
      const contentSha256 = createHash("sha256").update(baselineText).digest("hex");
      resolved.set(current.uri, {
        state: {
          uri: current.uri,
          languageId: current.languageId,
          documentVersion: null,
          isDirty: false,
          exists: true,
          blobSha256: null,
          contentSha256,
        },
        baselineText,
      });
    }
    return [...resolved.values()].sort((left, right) => left.state.uri.localeCompare(right.state.uri));
  }

  #requireActive(sessionId?: string): ActiveExperiment {
    const active = this.#active;
    if (!active) {
      throw new BridgeError("NO_ACTIVE_EXPERIMENT", "No active experiment exists in this window.");
    }
    if (sessionId && active.manifest.sessionId !== sessionId) {
      throw new BridgeError(
        "EXPERIMENT_NOT_FOUND",
        "The requested experiment is not active in this VS Code window.",
      );
    }
    return active;
  }

  #assertMutationAllowed(): void {
    if (vscode.env.remoteName) {
      throw new BridgeError("UNSUPPORTED_REMOTE", "Remote experiment sessions are not supported.");
    }
    if (!vscode.workspace.isTrusted) {
      throw new BridgeError(
        "WORKSPACE_UNTRUSTED",
        "Trust the workspace before starting or mutating an experiment.",
      );
    }
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function workspaceIdentity(root: vscode.Uri): string {
  return createHash("sha256").update(root.toString(true)).digest("hex");
}

function isUriWithin(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (candidate.scheme === "untitled") {
    return true;
  }
  if (root.scheme !== "file" || candidate.scheme !== "file") {
    return false;
  }
  const relative = path.relative(path.resolve(root.fsPath), path.resolve(candidate.fsPath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
}

async function resolveExistingDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString(true) === uri.toString(true),
  );
  if (open) {
    return open;
  }
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "A checkpoint document no longer exists.");
  }
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(true), uri])).values()];
}

function drainSet(values: Set<string>): string[] {
  const drained = [...values];
  values.clear();
  return drained;
}

function sameStoredDocument(
  left: StoredDocument | undefined,
  right: StoredDocument,
): boolean {
  return (
    left?.exists === right.exists &&
    left?.contentSha256 === right.contentSha256 &&
    left?.documentVersion === right.documentVersion &&
    left?.isDirty === right.isDirty
  );
}

function sameDocumentContent(
  left: readonly StoredDocument[],
  right: Iterable<StoredDocument>,
): boolean {
  const rightMap = new Map([...right].map((document) => [document.uri, document]));
  if (left.length !== rightMap.size) {
    return false;
  }
  return left.every((document) => {
    const current = rightMap.get(document.uri);
    return (
      current?.exists === document.exists &&
      current?.contentSha256 === document.contentSha256
    );
  });
}

function toPublicCheckpoint(checkpoint: StoredCheckpoint) {
  const { documents: _documents, ...publicCheckpoint } = checkpoint;
  return publicCheckpoint;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "FileNotFound"
  );
}
