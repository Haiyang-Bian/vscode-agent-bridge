import * as vscode from "vscode";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import { BridgeHost } from "./bridge-host.js";
import { registerBridgeHubUi } from "./bridge-hub-ui.js";
import { AgentActivityTracker } from "./agent-activity.js";
import { registerAgentActivityUi } from "./agent-activity-ui.js";
import { AgentEditorVisibility } from "./agent-editor-visibility.js";
import { ChangeSetManager } from "./change-set-manager.js";
import { CodexConfigConflictError, createManagedConfigBlock } from "./codex-config.js";
import { DebugManager } from "./debug-manager.js";
import { createDebugRequestHandlers } from "./debug-request-handlers.js";
import {
  configureCodexIntegration,
  inspectInstallation,
  removeCodexIntegration,
  resolveCodexConfigPath,
  resolveInstalledExecutablePath,
} from "./installation.js";
import { ExperimentManager } from "./experiment-manager.js";
import { ExtensionAwarenessManager } from "./extension-awareness-manager.js";
import { createExtensionAwarenessRequestHandlers } from "./extension-awareness-handlers.js";
import { ExtensionMarketplaceManager } from "./extension-marketplace-manager.js";
import { createExtensionMarketplaceRequestHandlers } from "./extension-marketplace-handlers.js";
import { ExtensionProfileManager } from "./extension-profile-manager.js";
import { createExtensionProfileRequestHandlers } from "./extension-profile-handlers.js";
import { ExtensionIntegrationManager } from "./extension-integration-manager.js";
import { createExtensionIntegrationRequestHandlers } from "./extension-integration-handlers.js";
import { IdeAutonomyManager } from "./ide-autonomy-manager.js";
import { registerExperimentUi } from "./experiment-ui.js";
import { ManagedWorktreeManager } from "./managed-worktree-manager.js";
import { registerManagedWorktreeUi } from "./managed-worktree-ui.js";
import {
  getBridgePolicyState,
} from "./policies.js";
import {
  createExperimentRequestHandlers,
  createIdeAutonomyRequestHandlers,
  createTerminalRequestHandlers,
  createWorkspaceRequestHandlers,
} from "./request-handlers.js";
import { TaskManager } from "./task-manager.js";
import { createTaskRequestHandlers } from "./task-request-handlers.js";
import { TerminalObserver } from "./terminal-observer.js";
import { WorkspaceOnboardingService } from "./workspace-onboarding.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";
import { createWorkspaceConfigurationRequestHandlers } from "./workspace-configuration-handlers.js";

let activeHost: BridgeHost | undefined;
let activeExperimentManager: ExperimentManager | undefined;
let activeTerminalObserver: TerminalObserver | undefined;

const ACCEPTANCE_ACTION_TITLE = "Apply VS Code Agent Bridge acceptance text edit";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VS Code Agent Bridge", { log: true });
  const host = new BridgeHost(output);
  const experiments = new ExperimentManager(context, host.instanceId, output);
  const onboarding = new WorkspaceOnboardingService(host.instanceId);
  const activity = new AgentActivityTracker();
  const visibility = new AgentEditorVisibility(onboarding);
  const changeSets = new ChangeSetManager(host.instanceId, experiments, visibility);
  const managed = new ManagedWorktreeManager(experiments);
  const terminals = new TerminalObserver(host.instanceId);
  const configurations = new WorkspaceConfigurationManager(host.instanceId, experiments);
  const tasks = new TaskManager(host.instanceId, experiments, terminals, activity);
  const debug = new DebugManager(host.instanceId, experiments, activity, configurations);
  const extensionAwareness = new ExtensionAwarenessManager(host.instanceId, terminals, tasks, debug);
  const extensionMarketplace = new ExtensionMarketplaceManager(host.instanceId, experiments);
  const extensionProfiles = new ExtensionProfileManager(host.instanceId, experiments, context.globalStorageUri);
  const extensionIntegrations = new ExtensionIntegrationManager(host.instanceId);
  const ideAutonomy = new IdeAutonomyManager(
    host.instanceId,
    experiments,
    changeSets,
    visibility,
  );
  host.registerRequestHandlers(
    createExperimentRequestHandlers(
      host.instanceId,
      experiments,
      changeSets,
      onboarding,
      activity,
    ),
  );
  host.registerRequestHandlers(createWorkspaceRequestHandlers(onboarding));
  host.registerRequestHandlers(createTerminalRequestHandlers(terminals));
  host.registerRequestHandlers(
    createWorkspaceConfigurationRequestHandlers(configurations, experiments, onboarding, activity),
  );
  host.registerRequestHandlers(createTaskRequestHandlers(tasks, experiments, onboarding, activity));
  host.registerRequestHandlers(createDebugRequestHandlers(debug, experiments, onboarding, activity));
  host.registerRequestHandlers(createExtensionAwarenessRequestHandlers(extensionAwareness));
  host.registerRequestHandlers(
    createExtensionMarketplaceRequestHandlers(extensionMarketplace, experiments, onboarding, activity),
  );
  host.registerRequestHandlers(
    createExtensionProfileRequestHandlers(extensionProfiles, experiments, onboarding, activity),
  );
  host.registerRequestHandlers(createExtensionIntegrationRequestHandlers(extensionIntegrations));
  host.registerRequestHandlers(
    createIdeAutonomyRequestHandlers(ideAutonomy, experiments, onboarding, activity),
  );
  try {
    await experiments.initialize();
    await host.markReady();
  } catch (error) {
    await host.markDegraded();
    output.error("Experiment storage initialization failed; the bridge is degraded.", error);
  }
  let reconcileQueue = Promise.resolve();
  const reconcileBridge = (): Promise<void> => {
    reconcileQueue = reconcileQueue
      .catch(() => undefined)
      .then(() => reconcileBridgePublication(host, output));
    return reconcileQueue;
  };
  await reconcileBridge();
  terminals.start();
  activeHost = host;
  activeExperimentManager = experiments;
  activeTerminalObserver = terminals;
  registerExperimentUi(context, experiments, onboarding, output);
  registerAgentActivityUi(context, activity);
  registerManagedWorktreeUi(context, managed, output);
  registerBridgeHubUi(context, {
    host,
    experiments,
    terminals,
    tasks,
    debug,
    extensionAwareness,
  });
  registerAcceptanceFixtureProvider(context);
  registerE2ECommands(context, experiments, managed, onboarding, activity, extensionProfiles);

  context.subscriptions.push(
    output,
    experiments,
    terminals,
    tasks,
    debug,
    extensionAwareness,
    vscode.commands.registerCommand("vscodeAgentBridge.showStatus", async () => {
      const policy = getBridgePolicyState();
      const remoteLabel = vscode.env.remoteName ? `, remote=${vscode.env.remoteName}` : "";
      await vscode.window.showInformationMessage(
        host.isListening
          ? `VS Code Agent Bridge is listening (instance=${host.instanceId}${remoteLabel}).`
          : `VS Code Agent Bridge is not published (enabled=${policy.enabled}, migrationRequired=${policy.legacyMigrationRequired}, trusted=${policy.workspaceTrusted}${remoteLabel}).`,
      );
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.copyInstanceId", async () => {
      await vscode.env.clipboard.writeText(host.instanceId);
      await vscode.window.showInformationMessage("VS Code Agent Bridge instance ID copied.");
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureCodex", async () => {
      await configureCodexCommand(context, output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureBridge", async () => {
      await configureBridgeCommand();
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureWorkspaceExperiment", async () => {
      await onboarding.configureInteractively();
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.removeCodexConfiguration", async () => {
      await removeCodexCommand(output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.runDoctor", async () => {
      await runDoctorCommand(context, host, experiments, managed, terminals, tasks, debug, configurations, output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.undoLastAgentProfileChange", async () => {
      const confirmed = await vscode.window.showWarningMessage(
        "Undo the latest Agent change to the current VS Code Profile? The value is restored only if it has not changed since.",
        { modal: true },
        "Undo",
      );
      if (confirmed !== "Undo") return;
      try {
        const undone = await extensionProfiles.undoLastGlobalChange();
        await vscode.window.showInformationMessage(
          undone ? "The latest Agent Profile change was undone." : "There is no Agent Profile change to undo.",
        );
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : "The Agent Profile change could not be undone.",
        );
      }
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.createCapabilityProfile", async () => {
      const commands = new Set(await vscode.commands.getCommands(true));
      const command = "workbench.profiles.actions.manageProfiles";
      if (!commands.has(command)) {
        await vscode.window.showErrorMessage("This VS Code build does not expose the native Profiles manager.");
        return;
      }
      await vscode.window.showInformationMessage(
        "Create or copy a Profile in VS Code, open it in a new window, then ask the Agent to inventory and configure that current Profile.",
      );
      await vscode.commands.executeCommand(command);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (host.isListening ? host.refreshDescriptor() : Promise.resolve());
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void reconcileBridge();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("vscodeAgentBridge.enabled") ||
        event.affectsConfiguration("vscodeAgentBridge.executionMode") ||
        event.affectsConfiguration("vscodeAgentBridge.autonomyProfile") ||
        event.affectsConfiguration("vscodeAgentBridge.terminalReadPolicy")
      ) {
        void reconcileBridge();
      }
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

  void maybeOfferLegacyPolicyMigration();
  if (getBridgePolicyState().publishAllowed) {
    void maybeOfferCodexSetup(context, output);
  }
}

function registerAcceptanceFixtureProvider(context: vscode.ExtensionContext): void {
  let registration: vscode.Disposable | undefined;

  const refreshRegistration = (): void => {
    const enabled = vscode.workspace
      .getConfiguration("vscodeAgentBridge")
      .get<boolean>("enableAcceptanceFixtures", false);
    if (enabled === Boolean(registration)) {
      return;
    }
    registration?.dispose();
    registration = undefined;
    if (!enabled) {
      return;
    }

    registration = vscode.languages.registerCodeActionsProvider(
      { scheme: "file", pattern: "**/*.bridgeaction" },
      {
        provideCodeActions(document) {
          const marker = "BROKEN_E2E";
          const markerOffset = document.getText().indexOf(marker);
          if (markerOffset < 0) {
            return [];
          }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(
              document.positionAt(markerOffset),
              document.positionAt(markerOffset + marker.length),
            ),
            "FIXED_E2E",
          );
          const action = new vscode.CodeAction(
            ACCEPTANCE_ACTION_TITLE,
            vscode.CodeActionKind.QuickFix,
          );
          action.edit = edit;
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    );
  };

  refreshRegistration();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vscodeAgentBridge.enableAcceptanceFixtures")) {
        refreshRegistration();
      }
    }),
    new vscode.Disposable(() => {
      registration?.dispose();
      registration = undefined;
    }),
  );
}

function registerE2ECommands(
  context: vscode.ExtensionContext,
  experiments: ExperimentManager,
  managed: ManagedWorktreeManager,
  onboarding: WorkspaceOnboardingService,
  activity: AgentActivityTracker,
  extensionProfiles: ExtensionProfileManager,
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
        const formattedText = "export const formattedValue = 42;\n";
        if (document.getText() === formattedText) {
          return undefined;
        }
        return [
          vscode.TextEdit.replace(
            new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
            formattedText,
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
      "vscodeAgentBridge.e2eConfigureWorkspaceExperiment",
      async (visibility: Parameters<WorkspaceOnboardingService["configureRoot"]>[2] = "focusFirst") => {
        const root = vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          throw new Error("The E2E workspace root is unavailable.");
        }
        await onboarding.configureRoot(root, true, visibility);
      },
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eGetAgentActivity", () => activity.entries),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eUndoLastProfileChange", () =>
      extensionProfiles.undoLastGlobalChange(),
    ),
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
    const result = await configureCodexIntegration(context);
    await vscode.window.showInformationMessage(
      result.changed || result.executableInstalled
        ? "Codex integration configured. Restart Codex to load the MCP server."
        : "Codex integration is already current.",
    );
  } catch (error) {
    if (error instanceof CodexConfigConflictError) {
      await vscode.env.clipboard.writeText(
        `${createManagedConfigBlock(resolveInstalledExecutablePath())}\n`,
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

async function configureBridgeCommand(): Promise<void> {
  const current = getBridgePolicyState();
  const enabled = await vscode.window.showQuickPick(
    [
      {
        label: "Enable full bridge",
        description: "Publish all accurately annotated IDE workflow tools in trusted local workspaces.",
        value: true,
      },
      {
        label: "Disable bridge",
        description: "Stop RPC, close active bridge connections and remove this window descriptor.",
        value: false,
      },
    ],
    {
      title: "VS Code Agent Bridge master switch",
      placeHolder: `Current: ${current.enabled ? "enabled" : "disabled"}`,
    },
  );
  if (!enabled) {
    return;
  }
  let executionMode = current.executionMode;
  if (enabled.value) {
    const selectedMode = await vscode.window.showQuickPick(
    [
      {
          label: "Explicit (Default)",
          description: "Only workflows directly requested through MCP may execute.",
          value: "explicit" as const,
      },
      {
          label: "Aggressive",
          description: "Also allow bounded deferred IDE workflows such as folder-open Tasks.",
          value: "aggressive" as const,
      },
    ],
    {
        title: "IDE workflow execution mode",
        placeHolder: `Current: ${current.executionMode}`,
    },
  );
    if (!selectedMode) {
      return;
    }
    executionMode = selectedMode.value;
  }
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  await Promise.all([
    configuration.update("enabled", enabled.value, vscode.ConfigurationTarget.Global),
    configuration.update("executionMode", executionMode, vscode.ConfigurationTarget.Global),
  ]);
  await vscode.window.showInformationMessage(
    enabled.value
      ? "VS Code Agent Bridge enabled. Codex or its supervising Agent decides per-tool approval from MCP annotations."
      : "VS Code Agent Bridge disabled. Existing deferred workspace configuration was not removed.",
  );
}

async function reconcileBridgePublication(
  host: BridgeHost,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const policy = getBridgePolicyState();
  if (policy.publishAllowed) {
    if (!host.isListening) {
      await host.start();
    } else {
      await host.refreshDescriptor();
    }
    return;
  }
  if (host.isListening) {
    await host.stop();
  }
  if (policy.legacyMigrationRequired) {
    output.warn("A restrictive pre-v0.7 policy is present; bridge publication is paused pending an explicit migration choice.");
  }
}

async function maybeOfferLegacyPolicyMigration(): Promise<void> {
  if (!getBridgePolicyState().legacyMigrationRequired) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "VS Code Agent Bridge v0.7 replaces readOnly/review/terminal policies with one master switch. Choose whether to enable the fully annotated bridge; no previous restriction will be silently widened.",
    { modal: true },
    "Enable v0.7 Bridge",
    "Keep Disabled",
  );
  if (!choice) {
    return;
  }
  await vscode.workspace
    .getConfiguration("vscodeAgentBridge")
    .update("enabled", choice === "Enable v0.7 Bridge", vscode.ConfigurationTarget.Global);
}

async function runDoctorCommand(
  context: vscode.ExtensionContext,
  host: BridgeHost,
  experiments: ExperimentManager,
  managed: ManagedWorktreeManager,
  terminals: TerminalObserver,
  tasks: TaskManager,
  debug: DebugManager,
  configurations: WorkspaceConfigurationManager,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const policy = getBridgePolicyState();
  const [report, experimentStats, managedReport] = await Promise.all([
    inspectInstallation(context),
    experiments.getStoreStats(),
    managed.repairReport().catch(() => []),
  ]);
  const deferredConfigurations = policy.executionMode === "aggressive"
    ? (await Promise.all(
        (vscode.workspace.workspaceFolders ?? []).flatMap((root) => [
          configurations.getConfiguration({ rootUri: root.uri.toString(true), target: "tasks" }),
          configurations.getConfiguration({ rootUri: root.uri.toString(true), target: "workspace" }),
        ]),
      )).filter((result) => result.deferredEffects).length
    : 0;
  const terminalStats = terminals.getStats();
  const commandIds = new Set(await vscode.commands.getCommands(true));
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
    `bridgeEnabled=${policy.enabled}`,
    `executionMode=${policy.executionMode}`,
    `legacyPolicyMigrationRequired=${policy.legacyMigrationRequired}`,
    `workspaceTrusted=${policy.workspaceTrusted}`,
    `remoteContext=${vscode.env.remoteName ? "unsupported" : "local"}`,
    `experimentSessions=${experimentStats.sessionCount}`,
    `activeExperiments=${experimentStats.activeCount}`,
    `corruptExperiments=${experimentStats.corruptCount}`,
    `experimentStorageBytes=${experimentStats.storageBytes}`,
    `legacyV1Experiments=${experimentStats.v1Count}`,
    `resourceV2Experiments=${experimentStats.v2Count}`,
    `resourceRecoveryRequired=${experimentStats.recoveryRequiredCount}`,
    `managedExperiments=${managedReport.length}`,
    `managedAttentionRequired=${managedReport.filter((item) => !item.worktreeRegistered || !item.worktreePathPresent || !item.branchMatches || item.state !== "ready").length}`,
    `terminalCount=${terminalStats.terminalCount}`,
    `terminalExecutions=${terminalStats.executionCount}`,
    `terminalExecutionsWithOutput=${terminalStats.executionsWithOutput}`,
    `terminalCompleteCoverage=${terminalStats.executionsWithCompleteCoverage}`,
    `terminalCaptureMemoryBytes=${terminalStats.memoryBytes}`,
    `activeTaskExecutions=${tasks.activeCount}`,
    `activeDebugSessions=${debug.activeCount}`,
    `deferredWorkflowConfigurations=${deferredConfigurations}`,
    `nativeExtensionInstall=${commandIds.has("workbench.extensions.installExtension") ? "available" : "user-action-only"}`,
    `nativeProfilesManager=${commandIds.has("workbench.profiles.actions.manageProfiles") ? "available" : "unavailable"}`,
  ];
  output.info(`Doctor report:\n${lines.join("\n")}`);
  output.show(true);
  const healthy =
    report.platformSupported &&
    report.versionAligned &&
    policy.publishAllowed &&
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
    const report = await inspectInstallation(context);
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
