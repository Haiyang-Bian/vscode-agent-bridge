import * as vscode from "vscode";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import type { ExperimentManifest } from "./experiment-store.js";
import { ManagedWorktreeManager } from "./managed-worktree-manager.js";

export function registerManagedWorktreeUi(
  context: vscode.ExtensionContext,
  managed: ManagedWorktreeManager,
  output: vscode.LogOutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodeAgentBridge.startManagedExperiment", async () => {
      await runManagedCommand(output, async () => {
        const folder = await pickWorkspaceFolder("Select the clean Git target worktree");
        if (!folder) {
          return;
        }
        const title = await vscode.window.showInputBox({
          title: "Start Managed Worktree Experiment",
          prompt: "One managed experiment promotes exactly one final delivery commit.",
          validateInput: requiredMessage,
        });
        if (!title) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Create and lock a private Git worktree for ${folder.uri.fsPath}? The target must be clean and the worktree will remain until you explicitly delete it.`,
          { modal: true },
          "Create Managed Worktree",
        );
        if (confirmation !== "Create Managed Worktree") {
          return;
        }
        const experiment = await managed.start({
          repositoryRoot: folder.uri.fsPath,
          title: title.trim(),
        });
        await vscode.window.showInformationMessage(
          `Managed experiment ${experiment.sessionId} created. Its locked worktree is opening in a new window.`,
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.openManagedExperiment", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(managed, () => true, "Open Managed Experiment");
        if (session) {
          await managed.open(session.sessionId);
        }
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.createPrivateCheckpointCommit", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(
          managed,
          (manifest) => manifest.lifecycle === "active",
          "Create Private Checkpoint Commit",
        );
        if (!session) {
          return;
        }
        const message = await vscode.window.showInputBox({
          title: "Private Checkpoint Commit",
          prompt: "This commit remains on the managed private branch and runs your normal Git hooks.",
          validateInput: requiredMessage,
        });
        if (!message) {
          return;
        }
        const commit = await managed.createPrivateCheckpointCommit(session.sessionId, message.trim());
        await vscode.window.showInformationMessage(`Private checkpoint commit created: ${commit.slice(0, 12)}.`);
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.syncManagedExperiment", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(
          managed,
          (manifest) => manifest.lifecycle === "active",
          "Sync Managed Experiment",
        );
        if (!session) {
          return;
        }
        const preview = await managed.previewSync(session.sessionId);
        if (!preview) {
          await vscode.window.showInformationMessage("The managed experiment is already based on the current target HEAD.");
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Rebase ${preview.commits.length} private commit(s) from ${preview.oldBase.slice(0, 12)} onto ${preview.newBase.slice(0, 12)}? The accepted candidate will be cleared.`,
          { modal: true },
          "Sync Experiment",
        );
        if (confirmation !== "Sync Experiment") {
          return;
        }
        await managed.sync(preview);
        await vscode.window.showInformationMessage("Managed experiment synchronized. Select a new accepted commit.");
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.continueManagedSync", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(managed, () => true, "Continue Experiment Sync");
        if (session) {
          await managed.continueSync(session.sessionId);
        }
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.abortManagedSync", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(managed, () => true, "Abort Experiment Sync");
        if (!session) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          "Abort the managed rebase and keep the private worktree? The accepted candidate remains cleared.",
          { modal: true },
          "Abort Sync",
        );
        if (confirmation === "Abort Sync") {
          await managed.abortSync(session.sessionId);
        }
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.finalizeManagedExperiment", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(
          managed,
          (manifest) => manifest.lifecycle === "active",
          "Finalize Managed Experiment",
        );
        if (!session) {
          return;
        }
        const preview = await managed.previewPromotion(session.sessionId);
        const message = await vscode.window.showInputBox({
          title: "Formal Delivery Commit",
          prompt: "This non-empty message will be used for the single commit added to the target branch.",
          validateInput: requiredMessage,
        });
        if (!message) {
          return;
        }
        const summary = preview.stat || `${preview.files.length} changed file(s)`;
        const confirmation = await vscode.window.showWarningMessage(
          `Promote accepted commit ${preview.acceptedCommit.slice(0, 12)} as one commit on target ${preview.targetHead.slice(0, 12)}?\n\n${summary}\n\nNo push or cleanup will run. Git hooks may have effects outside the repository that cannot be rolled back.`,
          { modal: true },
          "Promote One Commit",
        );
        if (confirmation !== "Promote One Commit") {
          return;
        }
        const formal = await managed.promote(preview, message.trim());
        await vscode.window.showInformationMessage(
          `Managed experiment finalized as ${formal.slice(0, 12)}. The private worktree and branch were retained.`,
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.abandonManagedExperiment", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(
          managed,
          (manifest) => manifest.lifecycle === "active",
          "Abandon Managed Experiment",
        );
        if (!session) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Abandon “${session.title}”? Its worktree and private branch will be retained until separately deleted.`,
          { modal: true },
          "Abandon Managed Experiment",
        );
        if (confirmation === "Abandon Managed Experiment") {
          await managed.abandon(session.sessionId);
        }
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.deleteManagedWorktree", async () => {
      await runManagedCommand(output, async () => {
        const session = await pickManagedSession(
          managed,
          (manifest) => manifest.lifecycle !== "active",
          "Delete Managed Worktree",
        );
        if (!session) {
          return;
        }
        const metadata = await managed.metadata(session.sessionId);
        const confirmation = await vscode.window.showWarningMessage(
          `Permanently remove this exact Git worktree?\n\n${metadata.worktreePath}\n\nThis cannot be undone. The private branch is deleted only if its SHA, upstream and worktree use still match the session.`,
          { modal: true },
          "Delete Exact Worktree",
        );
        if (confirmation !== "Delete Exact Worktree") {
          return;
        }
        let result;
        try {
          result = await managed.deleteManagedWorktree(session.sessionId, false);
        } catch (error) {
          if (!(error instanceof BridgeError) || error.code !== "WORKTREE_NOT_CLEAN") {
            throw error;
          }
          const force = await vscode.window.showWarningMessage(
            `Git reports saved or ignored files in the exact managed worktree:\n\n${metadata.worktreePath}\n\nForce removal permanently deletes them.`,
            { modal: true },
            "Force Remove Exact Worktree",
          );
          if (force !== "Force Remove Exact Worktree") {
            return;
          }
          result = await managed.deleteManagedWorktree(session.sessionId, true);
        }
        await vscode.window.showInformationMessage(
          result.branchRemoved
            ? "Managed worktree and matching private branch removed."
            : `Managed worktree removed; private branch retained. ${result.branchRetainedReason ?? ""}`,
        );
      });
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.repairManagedExperiments", async () => {
      await runManagedCommand(output, async () => {
        const report = await managed.repairReport();
        const lines = report.map(
          (item) =>
            `${item.sessionId} lifecycle=${item.lifecycle} state=${item.state} registered=${item.worktreeRegistered} pathPresent=${item.worktreePathPresent} branchMatches=${item.branchMatches}`,
        );
        output.info(`Managed experiment repair report:\n${lines.join("\n") || "no managed sessions"}`);
        output.show(true);
      });
    }),
  );
}

async function pickWorkspaceFolder(title: string): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window
    .showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title },
    )
    .then((item) => item?.folder);
}

async function pickManagedSession(
  managed: ManagedWorktreeManager,
  predicate: (manifest: ExperimentManifest) => boolean,
  title: string,
): Promise<ExperimentManifest | undefined> {
  const sessions = (await managed.managedSessions()).filter(predicate);
  return vscode.window
    .showQuickPick(
      sessions.map((manifest) => ({
        label: manifest.title,
        description: `${manifest.lifecycle} · ${manifest.sessionId}`,
        manifest,
      })),
      { title },
    )
    .then((item) => item?.manifest);
}

function requiredMessage(value: string): string | undefined {
  const length = value.trim().length;
  return length === 0
    ? "A non-empty message is required."
    : length > 2_000
      ? "Message must not exceed 2,000 characters."
      : undefined;
}

async function runManagedCommand(
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
          : "Managed experiment operation failed.";
    output.error("Managed experiment command failed.");
    await vscode.window.showErrorMessage(message);
  }
}
