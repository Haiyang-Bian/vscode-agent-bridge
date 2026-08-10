import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import { BridgeError, type ExperimentInfo } from "@vscode-agent-bridge/protocol";

import { ExperimentManager } from "./experiment-manager.js";
import type { ExperimentManifest, ManagedExperimentMetadata } from "./experiment-store.js";
import { samePath } from "./git-path.js";
import {
  GitCommandError,
  GitRunner,
  type GitRepositoryState,
  isPathWithin,
} from "./git-runner.js";

export interface StartManagedExperimentOptions {
  readonly repositoryRoot: string;
  readonly title: string;
}

export interface SyncPreview {
  readonly sessionId: string;
  readonly oldBase: string;
  readonly newBase: string;
  readonly commits: readonly string[];
}

export interface PromotionPreview {
  readonly sessionId: string;
  readonly targetHead: string;
  readonly acceptedCommit: string;
  readonly files: readonly string[];
  readonly stat: string;
}

export interface DeleteManagedWorktreeResult {
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly branchRetainedReason: string | null;
}

export interface ManagedRepairItem {
  readonly sessionId: string;
  readonly lifecycle: ExperimentManifest["lifecycle"];
  readonly worktreeRegistered: boolean;
  readonly worktreePathPresent: boolean;
  readonly branchMatches: boolean;
  readonly state: ManagedExperimentMetadata["state"];
}

export class ManagedWorktreeManager {
  readonly #experiments: ExperimentManager;
  readonly #git: GitRunner;
  readonly #managedRoot: string;

  constructor(experiments: ExperimentManager, git = new GitRunner()) {
    this.#experiments = experiments;
    this.#git = git;
    const localAppData = process.env.LOCALAPPDATA;
    const testRoot =
      process.env.VSCODE_AGENT_BRIDGE_E2E === "1"
        ? process.env.VSCODE_AGENT_BRIDGE_MANAGED_ROOT
        : undefined;
    this.#managedRoot = testRoot
      ? path.resolve(testRoot)
      : localAppData
      ? path.resolve(localAppData, "VSCodeAgentBridge", "worktrees")
      : "";
  }

  get managedRoot(): string {
    return this.#managedRoot;
  }

  async start(options: StartManagedExperimentOptions): Promise<ExperimentInfo> {
    this.#assertAvailable();
    const state = await this.#inspectTarget(options.repositoryRoot);
    if (!samePath(options.repositoryRoot, state.repositoryRoot)) {
      throw new BridgeError(
        "GIT_STATE_UNSUPPORTED",
        "Select the repository top-level folder when creating a managed experiment.",
      );
    }
    this.#assertTargetStartState(state);
    this.#assertNoDirtyDocuments(state.repositoryRoot);
    await this.#git.listWorktrees(state.repositoryRoot);

    const sessionId = randomUUID();
    const shortSessionId = sessionId.slice(0, 8);
    const repositoryHash = createHash("sha256")
      .update(state.repositoryRoot.toLowerCase())
      .digest("hex")
      .slice(0, 24);
    const worktreePath = path.resolve(this.#managedRoot, repositoryHash, sessionId);
    if (!isPathWithin(this.#managedRoot, worktreePath)) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Managed worktree path escaped its root.");
    }
    const branch = `vscode-agent-bridge/experiment/${compactDate()}-${shortSessionId}`;
    await mkdir(path.dirname(worktreePath), { recursive: true });

    try {
      await this.#git.addWorktree(state.repositoryRoot, worktreePath, branch, state.head);
      await this.#git.lockWorktree(
        state.repositoryRoot,
        worktreePath,
        `VS Code Agent Bridge experiment ${sessionId}`,
      );
    } catch (error) {
      throw toGitBridgeError(error, "Could not create and lock the managed worktree.");
    }

    const metadata: ManagedExperimentMetadata = {
      schemaVersion: 1,
      repositoryRoot: state.repositoryRoot,
      worktreePath,
      targetBranch: state.branch!,
      baseHead: state.head,
      experimentBranch: branch,
      experimentHead: state.head,
      acceptedCommit: null,
      formalCommit: null,
      state: "ready",
      syncTargetHead: null,
    };
    const experiment = await this.#experiments.createManagedExperimentSession({
      sessionId,
      title: options.title,
      worktreeRoot: vscode.Uri.file(worktreePath),
      metadata,
    });
    try {
      await this.open(sessionId);
    } catch {
      // The locked worktree and session are intentionally retained for explicit recovery.
    }
    return experiment;
  }

  async open(sessionId: string): Promise<void> {
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    this.#assertManagedPath(metadata.worktreePath);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(metadata.worktreePath), {
      forceNewWindow: true,
    });
  }

  async createPrivateCheckpointCommit(sessionId: string, message: string): Promise<string> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    this.#assertReady(metadata);
    this.#assertCurrentWorkspace(metadata.worktreePath, "private checkpoint commits");
    this.#assertNoDirtyDocuments(metadata.worktreePath);
    const state = await this.#git.inspectRepository(metadata.worktreePath);
    this.#assertExperimentState(state, metadata);
    if (state.clean) {
      throw new BridgeError("WORKTREE_NOT_CLEAN", "There are no saved changes to commit.");
    }
    try {
      const commit = await this.#git.createPrivateCommit(metadata.worktreePath, message);
      await this.#experiments.updateManagedMetadata(sessionId, { experimentHead: commit });
      await this.#experiments.captureGitHeadNow();
      return commit;
    } catch (error) {
      throw toGitBridgeError(error, "Private checkpoint commit failed; Git hooks and signing were preserved.");
    }
  }

  async previewSync(sessionId: string): Promise<SyncPreview | null> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    this.#assertReady(metadata);
    this.#assertCurrentWorkspace(metadata.worktreePath, "managed synchronization");
    this.#assertNoDirtyDocuments(metadata.worktreePath);
    const state = await this.#git.inspectRepository(metadata.worktreePath);
    this.#assertExperimentState(state, metadata);
    if (!state.clean) {
      throw new BridgeError("WORKTREE_NOT_CLEAN", "Save and commit or discard worktree changes before sync.");
    }
    const newBase = await this.#git.branchHead(metadata.repositoryRoot, metadata.targetBranch);
    if (newBase === metadata.baseHead) {
      return null;
    }
    if (!(await this.#git.isAncestor(metadata.repositoryRoot, metadata.baseHead, newBase))) {
      throw new BridgeError(
        "TARGET_MOVED",
        "The target branch was rewritten or moved backwards; create a new managed experiment.",
      );
    }
    if (await this.#git.hasMergeCommit(metadata.worktreePath, metadata.baseHead, metadata.experimentHead)) {
      throw new BridgeError(
        "GIT_STATE_UNSUPPORTED",
        "Automatic sync does not support private histories containing merge commits.",
      );
    }
    return {
      sessionId,
      oldBase: metadata.baseHead,
      newBase,
      commits: await this.#git.commitsBetween(
        metadata.worktreePath,
        metadata.baseHead,
        metadata.experimentHead,
      ),
    };
  }

  async sync(preview: SyncPreview): Promise<string> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(preview.sessionId);
    if (metadata.baseHead !== preview.oldBase) {
      throw new BridgeError("TARGET_MOVED", "The managed experiment changed after sync preview.");
    }
    const currentTarget = await this.#git.branchHead(metadata.repositoryRoot, metadata.targetBranch);
    if (currentTarget !== preview.newBase) {
      throw new BridgeError("TARGET_MOVED", "The target branch moved after sync preview.");
    }
    await this.#experiments.clearManagedAcceptedCandidate(preview.sessionId);
    try {
      await this.#git.rebaseOnto(metadata.worktreePath, preview.newBase, preview.oldBase);
    } catch (error) {
      const state = await this.#git.inspectRepository(metadata.worktreePath).catch(() => null);
      if (state?.operation === "rebase") {
        await this.#experiments.updateManagedMetadata(preview.sessionId, {
          state: "sync-conflicted",
          syncTargetHead: preview.newBase,
        });
        throw new BridgeError(
          "SYNC_CONFLICTED",
          "Managed sync stopped on conflicts. Resolve them, then continue or abort explicitly.",
        );
      }
      throw toGitBridgeError(error, "Managed sync failed before a recoverable rebase state was created.");
    }
    const head = await this.#git.head(metadata.worktreePath);
    await this.#experiments.updateManagedMetadata(preview.sessionId, {
      baseHead: preview.newBase,
      experimentHead: head,
      acceptedCommit: null,
      state: "ready",
      syncTargetHead: null,
    });
    await this.#experiments.captureGitHeadNow();
    return head;
  }

  async continueSync(sessionId: string): Promise<string> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    if (metadata.state !== "sync-conflicted") {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "The managed experiment is not awaiting rebase continuation.");
    }
    this.#assertCurrentWorkspace(metadata.worktreePath, "managed synchronization");
    if (!metadata.syncTargetHead) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "The conflicted sync target is missing.");
    }
    const targetHead = await this.#git.branchHead(metadata.repositoryRoot, metadata.targetBranch);
    if (targetHead !== metadata.syncTargetHead) {
      throw new BridgeError("TARGET_MOVED", "The target branch moved again during conflict resolution.");
    }
    try {
      await this.#git.continueRebase(metadata.worktreePath);
    } catch {
      throw new BridgeError("SYNC_CONFLICTED", "Rebase still has unresolved conflicts or a hook failed.");
    }
    const head = await this.#git.head(metadata.worktreePath);
    await this.#experiments.updateManagedMetadata(sessionId, {
      baseHead: metadata.syncTargetHead,
      experimentHead: head,
      state: "ready",
      acceptedCommit: null,
      syncTargetHead: null,
    });
    await this.#experiments.captureGitHeadNow();
    return head;
  }

  async abortSync(sessionId: string): Promise<void> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    if (metadata.state !== "sync-conflicted") {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "The managed experiment is not awaiting rebase abort.");
    }
    this.#assertCurrentWorkspace(metadata.worktreePath, "managed synchronization");
    try {
      await this.#git.abortRebase(metadata.worktreePath);
      const head = await this.#git.head(metadata.worktreePath);
      await this.#experiments.updateManagedMetadata(sessionId, {
        experimentHead: head,
        state: "ready",
        acceptedCommit: null,
        syncTargetHead: null,
      });
      await this.#experiments.captureGitHeadNow();
    } catch (error) {
      throw toGitBridgeError(error, "Could not abort the managed rebase.");
    }
  }

  async previewPromotion(sessionId: string): Promise<PromotionPreview> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    this.#assertReady(metadata);
    const target = await this.#inspectTarget(metadata.repositoryRoot);
    this.#assertCurrentWorkspace(metadata.repositoryRoot, "managed promotion");
    this.#assertNoDirtyDocuments(metadata.repositoryRoot);
    this.#assertPromotionTarget(target, metadata);
    const worktree = await this.#git.inspectRepository(metadata.worktreePath);
    this.#assertExperimentState(worktree, metadata);
    if (!worktree.clean) {
      throw new BridgeError("WORKTREE_NOT_CLEAN", "The experiment worktree must be clean before promotion.");
    }
    const acceptedCommit = metadata.acceptedCommit;
    if (!acceptedCommit) {
      throw new BridgeError(
        "ACCEPTED_COMMIT_REQUIRED",
        "Select a Git-backed experiment checkpoint before promotion.",
      );
    }
    if (
      !(await this.#git.isAncestor(metadata.worktreePath, metadata.baseHead, acceptedCommit)) ||
      !(await this.#git.isAncestor(metadata.worktreePath, acceptedCommit, metadata.experimentHead))
    ) {
      throw new BridgeError(
        "ACCEPTED_COMMIT_REQUIRED",
        "The accepted commit is not reachable on the managed private branch.",
      );
    }
    const summary = await this.#git.diffSummary(
      metadata.repositoryRoot,
      metadata.baseHead,
      acceptedCommit,
    );
    return {
      sessionId,
      targetHead: target.head,
      acceptedCommit,
      files: summary.files,
      stat: summary.stat,
    };
  }

  async promote(preview: PromotionPreview, message: string): Promise<string> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(preview.sessionId);
    this.#assertReady(metadata);
    const target = await this.#inspectTarget(metadata.repositoryRoot);
    this.#assertCurrentWorkspace(metadata.repositoryRoot, "managed promotion");
    this.#assertNoDirtyDocuments(metadata.repositoryRoot);
    this.#assertPromotionTarget(target, metadata);
    if (target.head !== preview.targetHead || metadata.acceptedCommit !== preview.acceptedCommit) {
      throw new BridgeError("TARGET_MOVED", "Target or accepted candidate changed after promotion preview.");
    }

    const acceptedTree = await this.#git.tree(metadata.repositoryRoot, preview.acceptedCommit);
    const temporaryCommit = await this.#git.commitTree(
      metadata.repositoryRoot,
      acceptedTree,
      target.head,
      message,
    );
    if ((await this.#git.head(metadata.repositoryRoot)) !== target.head) {
      throw new BridgeError("TARGET_MOVED", "The target branch moved immediately before promotion.");
    }
    try {
      await this.#git.cherryPick(metadata.repositoryRoot, temporaryCommit);
    } catch (error) {
      try {
        await this.#git.abortCherryPick(metadata.repositoryRoot);
        const recovered = await this.#git.inspectRepository(metadata.repositoryRoot);
        if (recovered.head !== target.head || !recovered.clean) {
          throw new Error("Target verification after abort failed.");
        }
      } catch {
        await this.#experiments.updateManagedMetadata(preview.sessionId, {
          state: "promotion-recovery-required",
        });
        throw new BridgeError(
          "PROMOTION_RECOVERY_REQUIRED",
          "Promotion failed and automatic cherry-pick abort could not prove a clean recovery.",
        );
      }
      throw toGitBridgeError(error, "Promotion failed and the target branch was restored.");
    }

    const formalCommit = await this.#git.head(metadata.repositoryRoot);
    const [parents, formalTree, commits] = await Promise.all([
      this.#git.commitParents(metadata.repositoryRoot, formalCommit),
      this.#git.tree(metadata.repositoryRoot, formalCommit),
      this.#git.commitsBetween(metadata.repositoryRoot, target.head, formalCommit),
    ]);
    if (
      parents.length !== 1 ||
      parents[0] !== target.head ||
      formalTree !== acceptedTree ||
      commits.length !== 1 ||
      commits[0] !== formalCommit
    ) {
      await this.#experiments.updateManagedMetadata(preview.sessionId, {
        state: "promotion-recovery-required",
      });
      throw new BridgeError(
        "PROMOTION_RECOVERY_REQUIRED",
        "The promoted commit failed parent/tree invariants; stop and inspect the target repository.",
      );
    }
    await this.#experiments.updateManagedMetadata(preview.sessionId, {
      formalCommit,
      state: "ready",
    });
    await this.#experiments.setManagedLifecycle(preview.sessionId, "finalized");
    return formalCommit;
  }

  async abandon(sessionId: string): Promise<void> {
    this.#assertAvailable();
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    if (metadata.state === "promotion-recovery-required") {
      throw new BridgeError(
        "PROMOTION_RECOVERY_REQUIRED",
        "Repair the target repository before abandoning this managed session.",
      );
    }
    await this.#experiments.setManagedLifecycle(sessionId, "abandoned");
  }

  async deleteManagedWorktree(
    sessionId: string,
    force: boolean,
  ): Promise<DeleteManagedWorktreeResult> {
    this.#assertAvailable();
    const manifest = (await this.#experiments.listAllManifests()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!manifest || manifest.mode !== "worktree") {
      throw new BridgeError("EXPERIMENT_NOT_FOUND", "Managed experiment was not found.");
    }
    if (manifest.lifecycle === "active") {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Finalize or abandon the session before deletion.");
    }
    const metadata = await this.#experiments.readManagedMetadata(sessionId);
    this.#assertManagedPath(metadata.worktreePath);
    const entries = await this.#git.listWorktrees(metadata.repositoryRoot);
    const entry = entries.find((candidate) => samePath(candidate.path, metadata.worktreePath));
    if (!entry) {
      throw new BridgeError("WORKTREE_NOT_FOUND", "The managed worktree is not registered in Git.");
    }
    if (entry.branch !== metadata.experimentBranch) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "The registered worktree branch no longer matches the session.");
    }
    const state = await this.#git.inspectRepository(metadata.worktreePath);
    if (state.operation) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Finish the Git operation before deleting the worktree.");
    }
    if (!state.clean && !force) {
      throw new BridgeError("WORKTREE_NOT_CLEAN", "The managed worktree is dirty; force removal needs separate confirmation.");
    }
    try {
      if (entry.locked) {
        await this.#git.unlockWorktree(metadata.repositoryRoot, metadata.worktreePath);
      }
      await this.#git.removeWorktree(metadata.repositoryRoot, metadata.worktreePath, force);
    } catch (error) {
      if (
        !force &&
        error instanceof GitCommandError &&
        /(modified or untracked|contains .*files|use --force)/iu.test(error.stderr)
      ) {
        throw new BridgeError(
          "WORKTREE_NOT_CLEAN",
          "Git found saved or ignored files that require the separate force-removal confirmation.",
        );
      }
      throw toGitBridgeError(error, "Git refused to remove the exact managed worktree.");
    }

    let branchRemoved = false;
    let branchRetainedReason: string | null = null;
    try {
      const upstream = await this.#git.branchUpstream(metadata.repositoryRoot, metadata.experimentBranch);
      const branchHead = await this.#git.branchHead(metadata.repositoryRoot, metadata.experimentBranch);
      const stillUsed = (await this.#git.listWorktrees(metadata.repositoryRoot)).some(
        (candidate) => candidate.branch === metadata.experimentBranch,
      );
      if (upstream) {
        branchRetainedReason = "The private branch has an upstream.";
      } else if (stillUsed) {
        branchRetainedReason = "The private branch is still used by another worktree.";
      } else if (branchHead !== metadata.experimentHead) {
        branchRetainedReason = "The private branch moved after the session recorded its expected head.";
      } else {
        await this.#git.deleteBranchRef(
          metadata.repositoryRoot,
          metadata.experimentBranch,
          metadata.experimentHead,
        );
        branchRemoved = true;
      }
    } catch {
      branchRetainedReason = "The private branch could not be verified and was retained.";
    }
    return { worktreeRemoved: true, branchRemoved, branchRetainedReason };
  }

  async repairReport(): Promise<ManagedRepairItem[]> {
    this.#assertAvailable();
    const managed = (await this.#experiments.listAllManifests()).filter(
      (manifest) => manifest.mode === "worktree",
    );
    return Promise.all(
      managed.map(async (manifest) => {
        const metadata = await this.#experiments.readManagedMetadata(manifest.sessionId);
        const entries = await this.#git.listWorktrees(metadata.repositoryRoot).catch(() => []);
        const entry = entries.find(
          (candidate) => samePath(candidate.path, metadata.worktreePath),
        );
        let worktreePathPresent = false;
        try {
          await this.#git.inspectRepository(metadata.worktreePath);
          worktreePathPresent = true;
        } catch {
          // Missing or invalid worktrees are reported, not repaired automatically.
        }
        return {
          sessionId: manifest.sessionId,
          lifecycle: manifest.lifecycle,
          worktreeRegistered: entry !== undefined,
          worktreePathPresent,
          branchMatches: entry?.branch === metadata.experimentBranch,
          state: metadata.state,
        };
      }),
    );
  }

  async managedSessions(): Promise<ExperimentManifest[]> {
    return (await this.#experiments.listAllManifests()).filter((manifest) => manifest.mode === "worktree");
  }

  async metadata(sessionId: string): Promise<ManagedExperimentMetadata> {
    return this.#experiments.readManagedMetadata(sessionId);
  }

  #assertAvailable(): void {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Managed worktrees currently require Windows x64.");
    }
    if (!this.#managedRoot) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "LOCALAPPDATA is unavailable.");
    }
    if (vscode.env.remoteName) {
      throw new BridgeError("UNSUPPORTED_REMOTE", "Managed worktrees are local-only.");
    }
    if (!vscode.workspace.isTrusted) {
      throw new BridgeError("WORKSPACE_UNTRUSTED", "Trust the workspace before using managed worktrees.");
    }
  }

  async #inspectTarget(repositoryRoot: string): Promise<GitRepositoryState> {
    try {
      return await this.#git.inspectRepository(repositoryRoot);
    } catch (error) {
      throw toGitBridgeError(error, "Git repository inspection failed.");
    }
  }

  #assertTargetStartState(state: GitRepositoryState): void {
    if (state.bare || !state.branch || state.operation || state.hasSubmodules) {
      throw new BridgeError(
        "GIT_STATE_UNSUPPORTED",
        "Managed experiments require a named local branch with no Git operation or submodules.",
      );
    }
    if (!state.clean) {
      throw new BridgeError("WORKTREE_NOT_CLEAN", "The target Git worktree must be completely clean.");
    }
  }

  #assertExperimentState(
    state: GitRepositoryState,
    metadata: ManagedExperimentMetadata,
  ): void {
    if (
      !samePath(state.repositoryRoot, metadata.worktreePath) ||
      state.branch !== metadata.experimentBranch ||
      state.bare ||
      state.hasSubmodules ||
      (state.operation && metadata.state !== "sync-conflicted")
    ) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Managed worktree Git state no longer matches the session.");
    }
  }

  #assertPromotionTarget(
    state: GitRepositoryState,
    metadata: ManagedExperimentMetadata,
  ): void {
    if (
      !samePath(state.repositoryRoot, metadata.repositoryRoot) ||
      state.branch !== metadata.targetBranch ||
      state.operation ||
      !state.clean
    ) {
      throw new BridgeError(
        "GIT_STATE_UNSUPPORTED",
        "Promotion must run from the clean original target branch and VS Code window.",
      );
    }
    if (state.head !== metadata.baseHead) {
      throw new BridgeError("TARGET_MOVED", "The target branch moved; sync the experiment explicitly first.");
    }
  }

  #assertReady(metadata: ManagedExperimentMetadata): void {
    if (metadata.state === "promotion-recovery-required") {
      throw new BridgeError(
        "PROMOTION_RECOVERY_REQUIRED",
        "Managed writes are disabled until the target repository is repaired.",
      );
    }
    if (metadata.state !== "ready") {
      throw new BridgeError("SYNC_CONFLICTED", "Finish or abort the conflicted synchronization first.");
    }
  }

  #assertCurrentWorkspace(expectedRoot: string, operation: string): void {
    const roots = vscode.workspace.workspaceFolders ?? [];
    if (
      roots.length !== 1 ||
      roots[0]!.uri.scheme !== "file" ||
      !samePath(roots[0]!.uri.fsPath, expectedRoot)
    ) {
      throw new BridgeError(
        "GIT_STATE_UNSUPPORTED",
        `Run ${operation} from the VS Code window that owns the exact required worktree.`,
      );
    }
  }

  #assertNoDirtyDocuments(root: string): void {
    const dirty = vscode.workspace.textDocuments.some(
      (document) =>
        document.isDirty &&
        document.uri.scheme === "file" &&
        isPathWithin(root, document.uri.fsPath),
    );
    if (dirty) {
      throw new BridgeError(
        "WORKTREE_NOT_CLEAN",
        "Save or revert all documents in the required worktree before this Git operation.",
      );
    }
  }

  #assertManagedPath(worktreePath: string): void {
    if (!isPathWithin(this.#managedRoot, worktreePath) || path.resolve(worktreePath) === this.#managedRoot) {
      throw new BridgeError("GIT_STATE_UNSUPPORTED", "Stored worktree path is outside the managed root.");
    }
  }
}

function compactDate(): string {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function toGitBridgeError(error: unknown, fallback: string): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  if (error instanceof GitCommandError) {
    const detail = error.stderr.trim().split(/\r?\n/u).at(-1);
    return new BridgeError("GIT_STATE_UNSUPPORTED", detail ? `${fallback} ${detail}` : fallback);
  }
  return new BridgeError("GIT_UNAVAILABLE", fallback);
}
