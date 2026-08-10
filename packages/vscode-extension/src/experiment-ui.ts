import * as vscode from "vscode";

import {
  BridgeError,
  MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS,
  type ExperimentCheckpoint,
} from "@vscode-agent-bridge/protocol";

import { ExperimentManager } from "./experiment-manager.js";
import type { ExperimentManifest, StoredCheckpoint } from "./experiment-store.js";
import { WorkspaceOnboardingService } from "./workspace-onboarding.js";

const SNAPSHOT_SCHEME = "vscode-agent-bridge-snapshot";
const VIEW_ID = "vscodeAgentBridge.experimentsView";

type ExperimentNode = SessionNode | CheckpointNode | EvidenceNode | MessageNode;

interface SessionNode {
  readonly kind: "session";
  readonly manifest: ExperimentManifest;
}

interface CheckpointNode {
  readonly kind: "checkpoint";
  readonly sessionId: string;
  readonly acceptedCheckpointId: string | null;
  readonly checkpoint: StoredCheckpoint;
}

interface EvidenceNode {
  readonly kind: "evidence";
  readonly evidence: ExperimentCheckpoint["evidence"][number];
}

interface MessageNode {
  readonly kind: "message";
  readonly label: string;
}

export function registerExperimentUi(
  context: vscode.ExtensionContext,
  experiments: ExperimentManager,
  onboarding: WorkspaceOnboardingService,
  output: vscode.LogOutputChannel,
): void {
  const provider = new ExperimentTreeProvider(experiments);
  const snapshotProvider = new ExperimentSnapshotProvider(experiments);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "vscodeAgentBridge.reviewExperiment";

  const updateStatus = async (): Promise<void> => {
    try {
      const experiment = await experiments.getActiveExperiment();
      status.text = `$(beaker) Experiment: ${experiment.title}`;
      status.tooltip = `${experiment.health} · ${experiment.sessionId}`;
      status.show();
    } catch {
      status.hide();
    }
  };

  context.subscriptions.push(
    provider,
    status,
    vscode.window.registerTreeDataProvider(VIEW_ID, provider),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotProvider),
    experiments.onDidChange(() => {
      provider.refresh();
      void updateStatus();
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.startExperiment", async () => {
      await runUiCommand(output, async () => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
          throw new BridgeError("INVALID_REQUEST", "Open a workspace folder before starting an experiment.");
        }
        const folder =
          folders.length === 1
            ? folders[0]!
            : await vscode.window.showQuickPick(
                folders.map((candidate) => ({
                  label: candidate.name,
                  description: candidate.uri.fsPath,
                  folder: candidate,
                })),
                { title: "Select the workspace root for this experiment" },
              ).then((item) => item?.folder);
        if (!folder) {
          return;
        }
        const title = await vscode.window.showInputBox({
          title: "Start Agent Experiment",
          prompt: "One experiment should represent one eventual delivery commit.",
          placeHolder: "Describe the semantic change",
          validateInput: (value) =>
            value.trim().length === 0
              ? "Experiment title is required."
              : value.length > MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS
                ? `Experiment title must be at most ${MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS} characters.`
                : undefined,
        });
        if (!title) {
          return;
        }
        const enabledNow = await onboarding.ensureEnabled(folder, title.trim(), "user");
        if (!enabledNow) {
          const confirmation = await vscode.window.showWarningMessage(
            `Start a local recovery journal for ${folder.name}? Snapshots can contain source code and are retained locally for up to 30 days or 500 MB.`,
            { modal: true },
            "Start Experiment",
          );
          if (confirmation !== "Start Experiment") {
            return;
          }
        }
        const experiment = await experiments.startWorkspaceExperiment({
          title: title.trim(),
          root: folder.uri,
        });
        await vscode.window.showInformationMessage(
          `Experiment started (${experiment.sessionId}). Agent writes now require this session ID.`,
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.reviewExperiment", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.createCheckpoint", async () => {
      await runUiCommand(output, async () => {
        const summary = await vscode.window.showInputBox({
          title: "Create Experiment Checkpoint",
          value: "Explicit experiment checkpoint",
          validateInput: (value) => (value.trim() ? undefined : "Checkpoint summary is required."),
        });
        if (!summary) {
          return;
        }
        const checkpointId = await experiments.createExplicitCheckpoint(summary.trim());
        await vscode.window.showInformationMessage(`Created checkpoint ${checkpointId}.`);
      });
    }),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.markCheckpointAccepted",
      async (node?: CheckpointNode) => {
        await runUiCommand(output, async () => {
          const selected = node?.kind === "checkpoint" ? node : await pickCheckpoint(experiments);
          if (!selected) {
            return;
          }
          await experiments.markAccepted(selected.checkpoint.checkpointId);
          await vscode.window.showInformationMessage(
            `Accepted checkpoint ${selected.checkpoint.checkpointId}. Save still does not finalize it.`,
          );
        });
      },
    ),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.reviewCheckpoint",
      async (node?: CheckpointNode) => {
        await runUiCommand(output, async () => {
          const selected = node?.kind === "checkpoint" ? node : await pickCheckpoint(experiments);
          if (!selected) {
            return;
          }
          await openCheckpointDiff(experiments, selected);
        });
      },
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.restoreAccepted", async () => {
      await runUiCommand(output, async () => {
        const experiment = await experiments.getActiveExperiment();
        if (!experiment.acceptedCheckpointId) {
          throw new BridgeError("INVALID_REQUEST", "Mark a checkpoint as accepted before restoring it.");
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Restore accepted checkpoint ${experiment.acceptedCheckpointId} to the workspace? A safety checkpoint will be created; v2 experiments may create, overwrite, or delete captured resources on disk.`,
          { modal: true },
          "Restore Accepted Candidate",
        );
        if (confirmation !== "Restore Accepted Candidate") {
          return;
        }
        await experiments.restoreAccepted();
        await vscode.window.showInformationMessage(
          "Accepted candidate restored. Resource-history experiments were written to disk; legacy text-only experiments remain dirty for review.",
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.finalizeExperiment", async () => {
      await runUiCommand(output, async () => {
        const experiment = await experiments.getActiveExperiment();
        const candidateRule = experiment.acceptedCheckpointId
          ? "Current content must match the accepted checkpoint"
          : experiment.mode === "workspace"
            ? "The current saved state will become an explicit final checkpoint"
            : "An accepted checkpoint is required";
        const confirmation = await vscode.window.showWarningMessage(
          `Finalize “${experiment.title}”? ${candidateRule}, and all files must already be saved. This does not create a Git commit.`,
          { modal: true },
          "Finalize Experiment",
        );
        if (confirmation !== "Finalize Experiment") {
          return;
        }
        await experiments.finalize();
        await vscode.window.showInformationMessage(
          "Experiment finalized. Review the net Git diff and create the delivery commit normally.",
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.abandonExperiment", async () => {
      await runUiCommand(output, async () => {
        const experiment = await experiments.getActiveExperiment();
        const confirmation = await vscode.window.showWarningMessage(
          `Abandon “${experiment.title}”? Workspace files will not be modified and recovery data will remain until retention cleanup.`,
          { modal: true },
          "Abandon Experiment",
        );
        if (confirmation !== "Abandon Experiment") {
          return;
        }
        await experiments.abandon();
      });
    }),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.renameExperiment",
      async (node?: SessionNode) => {
        await runUiCommand(output, async () => {
          const manifest = node?.kind === "session" ? node.manifest : await pickSession(experiments);
          if (!manifest) {
            return;
          }
          if (manifest.mode !== "workspace") {
            throw new BridgeError(
              "POLICY_DENIED",
              "Managed Worktree experiment metadata remains user-controlled.",
            );
          }
          const title = await vscode.window.showInputBox({
            title: "Rename Agent Experiment",
            value: manifest.title,
            validateInput: (value) =>
              value.trim().length === 0
                ? "Experiment title is required."
                : value.trim().length > MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS
                  ? `Experiment title must be at most ${MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS} characters.`
                  : /[\r\n\u0000-\u001f\u007f]/u.test(value)
                    ? "Experiment title cannot contain control characters."
                    : undefined,
          });
          if (!title || title.trim() === manifest.title) {
            return;
          }
          await experiments.renameOrdinaryExperiment({
            sessionId: manifest.sessionId,
            expectedTitle: manifest.title,
            title: title.trim(),
            reason: "User renamed the experiment in VS Code.",
          });
        });
      },
    ),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.toggleExperimentPinned",
      async (node?: SessionNode) => {
        await runUiCommand(output, async () => {
          const manifest = node?.kind === "session" ? node.manifest : await pickSession(experiments);
          if (!manifest) {
            return;
          }
          await experiments.setPinned(manifest.sessionId, !manifest.pinned);
        });
      },
    ),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.deleteExperiment",
      async (node?: SessionNode) => {
        await runUiCommand(output, async () => {
          const manifest = node?.kind === "session" ? node.manifest : await pickSession(experiments);
          if (!manifest) {
            return;
          }
          const confirmation = await vscode.window.showWarningMessage(
            `Permanently delete local recovery data for “${manifest.title}”? Workspace and Git files will not be changed.`,
            { modal: true },
            "Delete Experiment Data",
          );
          if (confirmation !== "Delete Experiment Data") {
            return;
          }
          await experiments.deleteExperiment(manifest.sessionId);
        });
      },
    ),
  );

  void updateStatus();
}

class ExperimentTreeProvider implements vscode.TreeDataProvider<ExperimentNode>, vscode.Disposable {
  readonly #experiments: ExperimentManager;
  readonly #emitter = new vscode.EventEmitter<ExperimentNode | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(experiments: ExperimentManager) {
    this.#experiments = experiments;
  }

  refresh(): void {
    this.#emitter.fire(undefined);
  }

  getTreeItem(node: ExperimentNode): vscode.TreeItem {
    if (node.kind === "session") {
      const item = new vscode.TreeItem(
        node.manifest.title,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${node.manifest.mode} · ${node.manifest.lifecycle} · ${node.manifest.health}`;
      item.tooltip = node.manifest.warnings.length
        ? node.manifest.warnings.join("\n")
        : node.manifest.sessionId;
      item.iconPath = new vscode.ThemeIcon(
        node.manifest.lifecycle === "active" ? "beaker" : "archive",
      );
      item.contextValue = node.manifest.lifecycle === "active" ? "activeExperiment" : "experiment";
      return item;
    }
    if (node.kind === "checkpoint") {
      const accepted = node.checkpoint.checkpointId === node.acceptedCheckpointId;
      const item = new vscode.TreeItem(
        `#${node.checkpoint.sequence} ${node.checkpoint.summary}`,
        node.checkpoint.evidence.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      item.description = `${node.checkpoint.source}${accepted ? " · accepted" : ""}`;
      item.iconPath = new vscode.ThemeIcon(accepted ? "pass-filled" : "history");
      item.contextValue = "experimentCheckpoint";
      item.command = {
        command: "vscodeAgentBridge.reviewCheckpoint",
        title: "Review Checkpoint",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "evidence") {
      const item = new vscode.TreeItem(
        `${node.evidence.kind}: ${node.evidence.status}`,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.evidence.source;
      item.tooltip = node.evidence.summary;
      item.iconPath = new vscode.ThemeIcon(
        node.evidence.status === "passed"
          ? "pass"
          : node.evidence.status === "failed"
            ? "error"
            : "question",
      );
      return item;
    }
    return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  }

  async getChildren(node?: ExperimentNode): Promise<ExperimentNode[]> {
    if (!node) {
      const manifests = await this.#experiments.listAllManifests();
      return manifests.length > 0
        ? manifests.map((manifest) => ({ kind: "session", manifest }))
        : [{ kind: "message", label: "No experiment history yet" }];
    }
    if (node.kind === "session") {
      try {
        return (await this.#experiments.readCheckpointList(node.manifest.sessionId)).map(
          (checkpoint) => ({
            kind: "checkpoint",
            sessionId: node.manifest.sessionId,
            acceptedCheckpointId: node.manifest.acceptedCheckpointId,
            checkpoint,
          }),
        );
      } catch {
        return [{ kind: "message", label: "Experiment history is unavailable" }];
      }
    }
    if (node.kind === "checkpoint") {
      return node.checkpoint.evidence.map((evidence) => ({ kind: "evidence", evidence }));
    }
    return [];
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

class ExperimentSnapshotProvider implements vscode.TextDocumentContentProvider {
  readonly #experiments: ExperimentManager;

  constructor(experiments: ExperimentManager) {
    this.#experiments = experiments;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const sessionId = query.get("sessionId");
    const checkpointId = query.get("checkpointId");
    const documentUri = query.get("documentUri");
    if (!sessionId || !checkpointId || !documentUri) {
      throw new Error("Experiment snapshot URI is incomplete.");
    }
    return this.#experiments.readSnapshotText(sessionId, checkpointId, documentUri);
  }
}

async function openCheckpointDiff(
  experiments: ExperimentManager,
  node: CheckpointNode,
): Promise<void> {
  const documents = node.checkpoint.documents.filter((document) => document.exists && document.blobSha256);
  if (documents.length === 0) {
    await vscode.window.showInformationMessage("This checkpoint contains no reviewable text document.");
    return;
  }
  const selected =
    documents.length === 1
      ? documents[0]!
      : await vscode.window.showQuickPick(
          documents.map((document) => ({
            label: vscode.workspace.asRelativePath(vscode.Uri.parse(document.uri, true), false),
            description: document.uri,
            document,
          })),
          { title: `Review checkpoint #${node.checkpoint.sequence}` },
        ).then((item) => item?.document);
  if (!selected) {
    return;
  }
  const currentUri = vscode.Uri.parse(selected.uri, true);
  const snapshotUri = vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `/checkpoint-${node.checkpoint.sequence}/${encodeURIComponent(currentUri.path.split("/").at(-1) ?? "document")}`,
    query: new URLSearchParams({
      sessionId: node.sessionId,
      checkpointId: node.checkpoint.checkpointId,
      documentUri: selected.uri,
    }).toString(),
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    snapshotUri,
    currentUri,
    `Checkpoint #${node.checkpoint.sequence} ↔ Current`,
  );
}

async function pickCheckpoint(experiments: ExperimentManager): Promise<CheckpointNode | undefined> {
  const experiment = await experiments.getActiveExperiment();
  const checkpoints = await experiments.readCheckpointList(experiment.sessionId);
  return vscode.window
    .showQuickPick(
      [...checkpoints].reverse().map((checkpoint) => ({
        label: `#${checkpoint.sequence} ${checkpoint.summary}`,
        description: checkpoint.source,
        checkpoint,
      })),
      { title: "Select an experiment checkpoint" },
    )
    .then((item) =>
      item
        ? {
            kind: "checkpoint",
            sessionId: experiment.sessionId,
            acceptedCheckpointId: experiment.acceptedCheckpointId,
            checkpoint: item.checkpoint,
          }
        : undefined,
    );
}

async function pickSession(experiments: ExperimentManager): Promise<ExperimentManifest | undefined> {
  const manifests = await experiments.listAllManifests();
  return vscode.window
    .showQuickPick(
      manifests.map((manifest) => ({
        label: manifest.title,
        description: `${manifest.lifecycle} · ${manifest.health}`,
        manifest,
      })),
      { title: "Select an experiment" },
    )
    .then((item) => item?.manifest);
}

async function runUiCommand(
  output: vscode.LogOutputChannel,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message =
      error instanceof BridgeError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "Experiment operation failed.";
    output.error("Experiment command failed.");
    await vscode.window.showErrorMessage(message);
  }
}
