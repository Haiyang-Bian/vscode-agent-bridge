import * as vscode from "vscode";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import { BridgeHost } from "./bridge-host.js";
import { ChangeSetManager } from "./change-set-manager.js";
import { CodexConfigConflictError, createManagedConfigBlock } from "./codex-config.js";
import {
  configureCodexIntegration,
  inspectInstallation,
  removeCodexIntegration,
  resolveCodexConfigPath,
  resolveInstalledExecutablePath,
} from "./installation.js";
import { ExperimentManager } from "./experiment-manager.js";
import { IdeAutonomyManager } from "./ide-autonomy-manager.js";
import { registerExperimentUi } from "./experiment-ui.js";
import { ManagedWorktreeManager } from "./managed-worktree-manager.js";
import { registerManagedWorktreeUi } from "./managed-worktree-ui.js";
import {
  getAgentPolicyOptions,
  getAutonomyProfile,
  getTerminalReadPolicy,
} from "./policies.js";
import {
  createExperimentRequestHandlers,
  createIdeAutonomyRequestHandlers,
  createTerminalRequestHandlers,
} from "./request-handlers.js";
import { TerminalObserver } from "./terminal-observer.js";

let activeHost: BridgeHost | undefined;
let activeExperimentManager: ExperimentManager | undefined;
let activeTerminalObserver: TerminalObserver | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VS Code Agent Bridge", { log: true });
  const host = new BridgeHost(output);
  const experiments = new ExperimentManager(context, host.instanceId, output);
  const changeSets = new ChangeSetManager(host.instanceId, experiments);
  const managed = new ManagedWorktreeManager(experiments);
  const terminals = new TerminalObserver(host.instanceId);
  const ideAutonomy = new IdeAutonomyManager(host.instanceId, experiments, changeSets);
  host.registerRequestHandlers(
    createExperimentRequestHandlers(host.instanceId, experiments, changeSets),
  );
  host.registerRequestHandlers(createTerminalRequestHandlers(terminals));
  host.registerRequestHandlers(createIdeAutonomyRequestHandlers(ideAutonomy));
  await experiments.initialize();
  terminals.start();
  activeHost = host;
  activeExperimentManager = experiments;
  activeTerminalObserver = terminals;
  registerExperimentUi(context, experiments, output);
  registerManagedWorktreeUi(context, managed, output);
  registerE2ECommands(context, experiments, managed);

  await host.start();

  context.subscriptions.push(
    output,
    experiments,
    terminals,
    vscode.commands.registerCommand("vscodeAgentBridge.showStatus", async () => {
      const remoteLabel = vscode.env.remoteName ? `, remote=${vscode.env.remoteName}` : "";
      await vscode.window.showInformationMessage(
        `VS Code Agent Bridge is listening (instance=${host.instanceId}${remoteLabel}).`,
      );
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.copyInstanceId", async () => {
      await vscode.env.clipboard.writeText(host.instanceId);
      await vscode.window.showInformationMessage("VS Code Agent Bridge instance ID copied.");
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureCodex", async () => {
      await configureCodexCommand(context, output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureAgentPolicies", async () => {
      await configureAgentPoliciesCommand();
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.removeCodexConfiguration", async () => {
      await removeCodexCommand(output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.runDoctor", async () => {
      await runDoctorCommand(context, host, experiments, managed, terminals, output);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void host.refreshDescriptor();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void host.refreshDescriptor();
    }),
    {
      dispose: () => {
        void host.stop();
      },
    },
  );

  if (vscode.env.remoteName) {
    output.warn(
      `Remote extension host detected (${vscode.env.remoteName}); remote routing is not yet supported.`,
    );
  }

  void maybeOfferCodexSetup(context, output);
}

function registerE2ECommands(
  context: vscode.ExtensionContext,
  experiments: ExperimentManager,
  managed: ManagedWorktreeManager,
): void {
  if (process.env.VSCODE_AGENT_BRIDGE_E2E !== "1") {
    return;
  }
  const formatterSelector: vscode.DocumentSelector = {
    scheme: "file",
    pattern: "**/*.bridgeformat",
  };
  const codeActionSelector: vscode.DocumentSelector = {
    scheme: "file",
    pattern: "**/*.bridgeaction",
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(formatterSelector, {
      provideDocumentFormattingEdits(document) {
        return [
          vscode.TextEdit.replace(
            new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
            "export const formattedValue = 42;\n",
          ),
        ];
      },
    }),
    vscode.languages.registerCodeActionsProvider(codeActionSelector, {
      provideCodeActions(document) {
        const safe = new vscode.CodeAction("Apply safe bridge E2E fix", vscode.CodeActionKind.QuickFix);
        const markerOffset = document.getText().indexOf("BROKEN_E2E");
        if (markerOffset >= 0) {
          safe.edit = new vscode.WorkspaceEdit();
          safe.edit.replace(
            document.uri,
            new vscode.Range(
              document.positionAt(markerOffset),
              document.positionAt(markerOffset + "BROKEN_E2E".length),
            ),
            "FIXED_E2E",
          );
        }

        const commandOnly = new vscode.CodeAction(
          "Unsupported command-only bridge E2E action",
          vscode.CodeActionKind.QuickFix,
        );
        commandOnly.command = {
          title: "Must never run",
          command: "vscodeAgentBridge.e2eNeverRun",
        };

        const resourceOperation = new vscode.CodeAction(
          "Unsupported resource bridge E2E action",
          vscode.CodeActionKind.QuickFix,
        );
        resourceOperation.edit = new vscode.WorkspaceEdit();
        resourceOperation.edit.createFile(vscode.Uri.joinPath(document.uri, "..", "forbidden.txt"));
        return [safe, commandOnly, resourceOperation];
      },
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eStartExperiment", async (title: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        throw new Error("The E2E workspace root is unavailable.");
      }
      return experiments.startWorkspaceExperiment({ title, root });
    }),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.e2eMarkCheckpointAccepted",
      (checkpointId: string) => experiments.markAccepted(checkpointId),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eCreateCheckpoint", (summary: string) =>
      experiments.createExplicitCheckpoint(summary),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eRestoreAccepted", () =>
      experiments.restoreAccepted(),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eFinalizeExperiment", () =>
      experiments.finalize(),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eAbandonExperiment", () =>
      experiments.abandon(),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eStartManagedExperiment", async (title: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        throw new Error("The E2E workspace root is unavailable.");
      }
      return managed.start({ repositoryRoot: root.fsPath, title });
    }),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.e2eSetManagedAcceptedCommit",
      (sessionId: string, acceptedCommit: string) =>
        experiments.updateManagedMetadata(sessionId, { acceptedCommit }),
    ),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.e2eUpdateManagedMetadata",
      (sessionId: string, update: Parameters<ExperimentManager["updateManagedMetadata"]>[1]) =>
        experiments.updateManagedMetadata(sessionId, update),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2ePreviewManagedPromotion", (sessionId: string) =>
      managed.previewPromotion(sessionId),
    ),
    vscode.commands.registerCommand(
      "vscodeAgentBridge.e2ePromoteManagedExperiment",
      (preview: Awaited<ReturnType<ManagedWorktreeManager["previewPromotion"]>>, message: string) =>
        managed.promote(preview, message),
    ),
  );
}

export async function deactivate(): Promise<void> {
  const host = activeHost;
  const experiments = activeExperimentManager;
  const terminals = activeTerminalObserver;
  activeHost = undefined;
  activeExperimentManager = undefined;
  activeTerminalObserver = undefined;
  terminals?.dispose();
  await experiments?.disposeAsync();
  await host?.stop();
}

async function configureCodexCommand(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "VS Code Agent Bridge will install its local MCP executable, back up ~/.codex/config.toml when it exists, and update only its managed configuration block. Restart Codex after configuration.",
    { modal: true },
    "Configure Codex",
  );
  if (choice !== "Configure Codex") {
    return;
  }

  try {
    const result = await configureCodexIntegration(context, getAgentPolicyOptions());
    await vscode.window.showInformationMessage(
      result.changed || result.executableInstalled
        ? "Codex integration configured. Restart Codex to load the MCP server."
        : "Codex integration is already current.",
    );
  } catch (error) {
    if (error instanceof CodexConfigConflictError) {
      await vscode.env.clipboard.writeText(
        `${createManagedConfigBlock(resolveInstalledExecutablePath(), getAgentPolicyOptions())}\n`,
      );
      await openCodexConfig();
      await vscode.window.showWarningMessage(
        "An unmanaged vscode_agent_bridge table already exists. No configuration was overwritten; the managed snippet was copied to the clipboard.",
      );
      return;
    }
    output.error("Codex integration configuration failed.");
    await vscode.window.showErrorMessage(toUserMessage(error));
  }
}

async function removeCodexCommand(output: vscode.LogOutputChannel): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Remove only the configuration block managed by VS Code Agent Bridge? Other Codex settings and installed versioned executables will be preserved.",
    { modal: true },
    "Remove Configuration",
  );
  if (choice !== "Remove Configuration") {
    return;
  }

  try {
    const result = await removeCodexIntegration();
    await vscode.window.showInformationMessage(
      result.changed
        ? "VS Code Agent Bridge configuration removed. Restart Codex to apply the change."
        : "No managed VS Code Agent Bridge configuration was found.",
    );
  } catch (error) {
    output.error("Removing Codex integration failed.");
    await vscode.window.showErrorMessage(toUserMessage(error));
  }
}

async function configureAgentPoliciesCommand(): Promise<void> {
  const autonomy = await vscode.window.showQuickPick(
    [
      {
        label: "Autonomous (Default)",
        description: "Guarded IDE writes can run without per-tool approval and may save.",
        value: "autonomous" as const,
      },
      {
        label: "Review",
        description: "Codex prompts for writes and Finalize requires an accepted checkpoint.",
        value: "review" as const,
      },
      {
        label: "Read Only",
        description: "The bridge rejects every Agent write.",
        value: "readOnly" as const,
      },
    ],
    {
      title: "Agent autonomy profile",
      placeHolder: `Current: ${getAutonomyProfile()}`,
    },
  );
  if (!autonomy) {
    return;
  }
  const terminal = await vscode.window.showQuickPick(
    [
      {
        label: "Allow (Default)",
        description: "Trusted workspaces may expose captured command lines and output.",
        value: "allow" as const,
      },
      {
        label: "Metadata Only",
        description: "Expose terminal names, process IDs, lifecycle and coverage only.",
        value: "metadataOnly" as const,
      },
      {
        label: "Deny",
        description: "Do not expose terminal tools or retain new terminal output.",
        value: "deny" as const,
      },
    ],
    {
      title: "Terminal read policy",
      placeHolder: `Current: ${getTerminalReadPolicy()}`,
    },
  );
  if (!terminal) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  await Promise.all([
    configuration.update("autonomyProfile", autonomy.value, vscode.ConfigurationTarget.Global),
    configuration.update("terminalReadPolicy", terminal.value, vscode.ConfigurationTarget.Global),
  ]);
  await vscode.window.showInformationMessage(
    "Agent policies updated. Run “VS Code Agent Bridge: Configure Codex” and restart Codex to update its managed tool list and approval mode.",
  );
}

async function runDoctorCommand(
  context: vscode.ExtensionContext,
  host: BridgeHost,
  experiments: ExperimentManager,
  managed: ManagedWorktreeManager,
  terminals: TerminalObserver,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const policies = getAgentPolicyOptions();
  const [report, experimentStats, managedReport] = await Promise.all([
    inspectInstallation(context, policies),
    experiments.getStoreStats(),
    managed.repairReport().catch(() => []),
  ]);
  const terminalStats = terminals.getStats();
  const lines = [
    `releaseVersion=${report.releaseVersion}`,
    `extensionVersion=${report.extensionVersion}`,
    `versionAligned=${report.versionAligned}`,
    `protocolVersion=${report.protocolVersion}`,
    `platformSupported=${report.platformSupported}`,
    `bridgeListening=${host.isListening}`,
    `bundledExecutable=${report.bundledExecutable}`,
    `installedExecutable=${report.installedExecutable}`,
    `codexConfig=${report.codexConfig}`,
    `autonomyProfile=${policies.autonomyProfile}`,
    `terminalReadPolicy=${policies.terminalReadPolicy}`,
    `remoteContext=${vscode.env.remoteName ? "unsupported" : "local"}`,
    `experimentSessions=${experimentStats.sessionCount}`,
    `activeExperiments=${experimentStats.activeCount}`,
    `corruptExperiments=${experimentStats.corruptCount}`,
    `experimentStorageBytes=${experimentStats.storageBytes}`,
    `managedExperiments=${managedReport.length}`,
    `managedAttentionRequired=${managedReport.filter((item) => !item.worktreeRegistered || !item.worktreePathPresent || !item.branchMatches || item.state !== "ready").length}`,
    `terminalCount=${terminalStats.terminalCount}`,
    `terminalExecutions=${terminalStats.executionCount}`,
    `terminalExecutionsWithOutput=${terminalStats.executionsWithOutput}`,
    `terminalCompleteCoverage=${terminalStats.executionsWithCompleteCoverage}`,
    `terminalCaptureMemoryBytes=${terminalStats.memoryBytes}`,
  ];
  output.info(`Doctor report:\n${lines.join("\n")}`);
  output.show(true);
  const healthy =
    report.platformSupported &&
    report.versionAligned &&
    host.isListening &&
    report.bundledExecutable === "present" &&
    report.installedExecutable === "present" &&
    report.codexConfig === "current" &&
    !vscode.env.remoteName;
  await vscode.window.showInformationMessage(
    healthy
      ? "VS Code Agent Bridge Doctor: all release checks passed."
      : "VS Code Agent Bridge Doctor found setup items; see the output channel.",
  );
}

async function maybeOfferCodexSetup(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> {
  if (process.env.VSCODE_AGENT_BRIDGE_E2E === "1") {
    return;
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    return;
  }
  const promptKey = `setupPromptShown:${BRIDGE_RELEASE_VERSION}`;
  if (context.globalState.get<boolean>(promptKey)) {
    return;
  }
  await context.globalState.update(promptKey, true);

  try {
    const report = await inspectInstallation(context, getAgentPolicyOptions());
    if (report.codexConfig === "current" && report.installedExecutable === "present") {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      "VS Code Agent Bridge is active. Configure its bundled MCP server for Codex?",
      "Configure Codex",
      "Not now",
    );
    if (choice === "Configure Codex") {
      await vscode.commands.executeCommand("vscodeAgentBridge.configureCodex");
    }
  } catch {
    output.warn("Could not inspect the Codex integration during first-run setup.");
  }
}

async function openCodexConfig(): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolveCodexConfigPath()));
  await vscode.window.showTextDocument(document, { preview: false });
}

function toUserMessage(error: unknown): string {
  return error instanceof Error ? error.message : "VS Code Agent Bridge setup failed.";
}
