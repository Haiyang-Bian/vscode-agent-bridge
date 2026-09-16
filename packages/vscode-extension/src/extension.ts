import * as vscode from "vscode";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "./agent-activity.js";
import { registerAgentActivityUi } from "./agent-activity-ui.js";
import { BridgeHost } from "./bridge-host.js";
import { registerBridgeHubUi } from "./bridge-hub-ui.js";
import { initializePublishedBridge } from "./bridge-lifecycle.js";
import { ChangeSetManager } from "./change-set-manager.js";
import { CodexConfigConflictError } from "./codex-config.js";
import { DebugManager } from "./debug-manager.js";
import { createDebugRequestHandlers } from "./debug-request-handlers.js";
import { ExtensionAwarenessManager } from "./extension-awareness-manager.js";
import { createExtensionAwarenessRequestHandlers } from "./extension-awareness-handlers.js";
import { ExtensionIntegrationManager } from "./extension-integration-manager.js";
import { createExtensionIntegrationRequestHandlers } from "./extension-integration-handlers.js";
import { ExtensionMarketplaceManager } from "./extension-marketplace-manager.js";
import { createExtensionMarketplaceRequestHandlers } from "./extension-marketplace-handlers.js";
import { ExtensionProfileManager } from "./extension-profile-manager.js";
import { createExtensionProfileRequestHandlers } from "./extension-profile-handlers.js";
import { IdeAutonomyManager } from "./ide-autonomy-manager.js";
import {
  configureCodexIntegration,
  inspectInstallation,
  removeCodexIntegration,
  resolveCodexConfigPath,
} from "./installation.js";
import { LegacyExperimentData } from "./legacy-experiment-data.js";
import { getBridgePolicyState } from "./policies.js";
import {
  createChangeRequestHandlers,
  createIdeAutonomyRequestHandlers,
  createTerminalRequestHandlers,
  createWorkspaceRequestHandlers,
} from "./request-handlers.js";
import { TaskManager } from "./task-manager.js";
import { createTaskRequestHandlers } from "./task-request-handlers.js";
import { TerminalObserver } from "./terminal-observer.js";
import { WorkspaceConfigurationManager } from "./workspace-configuration-manager.js";
import { createWorkspaceConfigurationRequestHandlers } from "./workspace-configuration-handlers.js";
import { WorkspaceSetupService } from "./workspace-setup.js";
import { WorkflowProvenanceStore } from "./workflow-provenance.js";

let activeHost: BridgeHost | undefined;
let activeTerminalObserver: TerminalObserver | undefined;

const ACCEPTANCE_ACTION_TITLE = "Apply VS Code Agent Bridge acceptance text edit";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VS Code Agent Bridge", { log: true });
  const host = new BridgeHost(output);
  const setup = new WorkspaceSetupService(host.instanceId);
  const activity = new AgentActivityTracker();
  const changeSets = new ChangeSetManager(host.instanceId);
  const terminals = new TerminalObserver(host.instanceId);
  const configurations = new WorkspaceConfigurationManager(host.instanceId);
  const provenance = new WorkflowProvenanceStore(context.workspaceState);
  const tasks = new TaskManager(host.instanceId, terminals, activity, configurations, provenance);
  const debug = new DebugManager(host.instanceId, activity, configurations, tasks, provenance);
  const extensionAwareness = new ExtensionAwarenessManager(host.instanceId, terminals, tasks, debug);
  const extensionMarketplace = new ExtensionMarketplaceManager(host.instanceId);
  const extensionProfiles = new ExtensionProfileManager(host.instanceId, context.globalStorageUri);
  const extensionIntegrations = new ExtensionIntegrationManager(host.instanceId);
  const ideAutonomy = new IdeAutonomyManager(host.instanceId, changeSets);
  const legacyData = new LegacyExperimentData(context.globalStorageUri);

  host.registerRequestHandlers(createChangeRequestHandlers(changeSets, activity));
  host.registerRequestHandlers(createWorkspaceRequestHandlers(setup));
  host.registerRequestHandlers(createTerminalRequestHandlers(terminals));
  host.registerRequestHandlers(createWorkspaceConfigurationRequestHandlers(configurations, activity));
  host.registerRequestHandlers(createTaskRequestHandlers(tasks, activity));
  host.registerRequestHandlers(createDebugRequestHandlers(debug, activity));
  host.registerRequestHandlers(createExtensionAwarenessRequestHandlers(extensionAwareness));
  host.registerRequestHandlers(createExtensionMarketplaceRequestHandlers(extensionMarketplace, activity));
  host.registerRequestHandlers(createExtensionProfileRequestHandlers(extensionProfiles, activity));
  host.registerRequestHandlers(createExtensionIntegrationRequestHandlers(extensionIntegrations));
  host.registerRequestHandlers(createIdeAutonomyRequestHandlers(ideAutonomy, activity));

  let reconcileQueue = Promise.resolve();
  const reconcileBridge = (): Promise<void> => {
    reconcileQueue = reconcileQueue.catch(() => undefined).then(() => reconcileBridgePublication(host, output));
    return reconcileQueue;
  };
  await initializePublishedBridge(
    host,
    reconcileBridge,
    () => extensionProfiles.initialize(),
    (error) => output.error("Bridge storage initialization failed; the bridge is degraded.", error),
  );
  terminals.start();
  activeHost = host;
  activeTerminalObserver = terminals;
  registerAgentActivityUi(context, activity);
  registerBridgeHubUi(context, { host, terminals, tasks, debug, extensionAwareness, legacyData });
  registerAcceptanceFixtureProvider(context);
  registerE2ECommands(context, activity, extensionProfiles, legacyData);

  context.subscriptions.push(
    output,
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
          : `VS Code Agent Bridge is not published (enabled=${policy.enabled}, trusted=${policy.workspaceTrusted}${remoteLabel}).`,
      );
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.copyInstanceId", async () => {
      await vscode.env.clipboard.writeText(host.instanceId);
      await vscode.window.showInformationMessage("VS Code Agent Bridge instance ID copied.");
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.configureCodex", () => configureCodexCommand(context, output)),
    vscode.commands.registerCommand("vscodeAgentBridge.configureBridge", configureBridgeCommand),
    vscode.commands.registerCommand("vscodeAgentBridge.removeCodexConfiguration", () => removeCodexCommand(context, output)),
    vscode.commands.registerCommand("vscodeAgentBridge.runDoctor", () =>
      runDoctorCommand(context, host, terminals, tasks, debug, configurations, extensionProfiles, legacyData, output),
    ),
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
        await vscode.window.showInformationMessage("The current VS Code stable API does not expose Profile management.");
        return;
      }
      await vscode.commands.executeCommand(command);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void (host.isListening ? host.refreshDescriptor() : Promise.resolve());
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void reconcileBridge()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vscodeAgentBridge.enabled")) void reconcileBridge();
    }),
    { dispose: () => { void host.stop(); } },
  );

  if (vscode.env.remoteName) {
    output.warn(`Remote extension host detected (${vscode.env.remoteName}); remote routing is not supported.`);
  }
  if (getBridgePolicyState().publishAllowed) void maybeOfferCodexSetup(context, output);
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
  activity: AgentActivityTracker,
  extensionProfiles: ExtensionProfileManager,
  legacyData: LegacyExperimentData,
): void {
  if (process.env.VSCODE_AGENT_BRIDGE_E2E !== "1") return;
  const formatterSelector: vscode.DocumentSelector = { scheme: "file", pattern: "**/*.bridgeformat" };
  const codeActionSelector: vscode.DocumentSelector = { scheme: "file", pattern: "**/*.bridgeaction" };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(formatterSelector, {
      provideDocumentFormattingEdits(document) {
        const formattedText = "export const formattedValue = 42;\n";
        if (document.getText() === formattedText) return undefined;
        return [vscode.TextEdit.replace(
          new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
          formattedText,
        )];
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
            new vscode.Range(document.positionAt(markerOffset), document.positionAt(markerOffset + "BROKEN_E2E".length)),
            "FIXED_E2E",
          );
        }
        const commandOnly = new vscode.CodeAction("Unsupported command-only bridge E2E action", vscode.CodeActionKind.QuickFix);
        commandOnly.command = { title: "Must never run", command: "vscodeAgentBridge.e2eNeverRun" };
        const resourceOperation = new vscode.CodeAction("Unsupported resource bridge E2E action", vscode.CodeActionKind.QuickFix);
        resourceOperation.edit = new vscode.WorkspaceEdit();
        resourceOperation.edit.createFile(vscode.Uri.joinPath(document.uri, "..", "forbidden.txt"));
        return [safe, commandOnly, resourceOperation];
      },
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eGetAgentActivity", () => activity.entries),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eUndoLastProfileChange", () => extensionProfiles.undoLastGlobalChange()),
    vscode.commands.registerCommand("vscodeAgentBridge.e2eHasLegacyExperimentData", () => legacyData.exists()),
  );
}
export async function deactivate(): Promise<void> {
  const host = activeHost;
  const terminals = activeTerminalObserver;
  activeHost = undefined;
  activeTerminalObserver = undefined;
  terminals?.dispose();
  await host?.stop();
}

async function configureCodexCommand(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "VS Code Agent Bridge will install a shared HTTP service and a current-user login task, start and verify the service, then back up and update its managed Codex configuration. New Codex clients will share this service.",
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
        ? "Shared HTTP service configured. Start a new Codex client to use it."
        : "Codex integration is already current.",
    );
  } catch (error) {
    if (error instanceof CodexConfigConflictError) {
      await openCodexConfig();
      await vscode.window.showWarningMessage(
        "The bridge configuration conflicts with an existing entry or another installation is running. Review the configuration and retry Configure Codex.",
      );
      return;
    }
    output.error("Codex integration configuration failed.");
    await vscode.window.showErrorMessage(toUserMessage(error));
  }
}

async function removeCodexCommand(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Stop the shared HTTP service, remove its login task and managed Codex configuration? Other settings and installed version files will be preserved.",
    { modal: true },
    "Remove Configuration",
  );
  if (choice !== "Remove Configuration") {
    return;
  }

  try {
    const result = await removeCodexIntegration(context);
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
  const configuration = vscode.workspace.getConfiguration("vscodeAgentBridge");
  await configuration.update("enabled", enabled.value, vscode.ConfigurationTarget.Global);
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
}

async function runDoctorCommand(
  context: vscode.ExtensionContext,
  host: BridgeHost,
  terminals: TerminalObserver,
  tasks: TaskManager,
  debug: DebugManager,
  configurations: WorkspaceConfigurationManager,
  extensionProfiles: ExtensionProfileManager,
  legacyData: LegacyExperimentData,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const policy = getBridgePolicyState();
  const [report, profileJournal, legacyExperimentData] = await Promise.all([
    inspectInstallation(context),
    extensionProfiles.journalHealth()
      .catch(() => ({ pendingCount: 0, attentionRequiredCount: 1, healthy: false })),
    legacyData.exists(),
  ]);
  const configurationReports = await Promise.all(
    (vscode.workspace.workspaceFolders ?? []).flatMap((root) => [
      configurations.getConfiguration({ rootUri: root.uri.toString(true), target: "tasks" }),
      configurations.getConfiguration({ rootUri: root.uri.toString(true), target: "workspace" }),
    ]),
  );
  const deferredConfigurations = configurationReports.filter((result) => result.deferredEffects);
  const terminalStats = terminals.getStats();
  const installationHealthy =
    report.platformSupported &&
    report.versionAligned &&
    report.bundledExecutable === "present" &&
    report.installedExecutable === "present" &&
    report.codexConfig === "current" &&
    report.httpService === "ready" &&
    report.loginTask === "present";
  const runtimeHealthy =
    policy.publishAllowed &&
    host.isListening &&
    host.lifecycle === "ready" &&
    host.descriptorHealthy &&
    !vscode.env.remoteName;
  const healthy = installationHealthy && runtimeHealthy && profileJournal.healthy;
  const lines = [
    `releaseVersion=${report.releaseVersion}`,
    `extensionVersion=${report.extensionVersion}`,
    `versionAligned=${report.versionAligned}`,
    `protocolVersion=${report.protocolVersion}`,
    `platformSupported=${report.platformSupported}`,
    `bridgeListening=${host.isListening}`,
    `bridgeLifecycle=${host.lifecycle}`,
    `registryAclHealthy=${host.descriptorHealthy}`,
    `bundledExecutable=${report.bundledExecutable}`,
    `installedExecutable=${report.installedExecutable}`,
    `codexConfig=${report.codexConfig}`,
    `httpService=${report.httpService}`,
    `loginTask=${report.loginTask}`,
    `serviceVersion=${report.serviceVersion ?? "unavailable"}`,
    `servicePid=${report.servicePid ?? "unavailable"}`,
    `bridgeEnabled=${policy.enabled}`,
    `workspaceTrusted=${policy.workspaceTrusted}`,
    `remoteContext=${vscode.env.remoteName ? "unsupported" : "local"}`,
    `legacyExperimentData=${legacyExperimentData ? "preserved-not-loaded" : "absent"}`,
    `profileJournalPending=${profileJournal.pendingCount}`,
    `profileJournalAttentionRequired=${profileJournal.attentionRequiredCount}`,
    `profileJournalHealthy=${profileJournal.healthy}`,
    `terminalCount=${terminalStats.terminalCount}`,
    `terminalExecutions=${terminalStats.executionCount}`,
    `terminalExecutionsWithOutput=${terminalStats.executionsWithOutput}`,
    `terminalCompleteCoverage=${terminalStats.executionsWithCompleteCoverage}`,
    `terminalCaptureMemoryBytes=${terminalStats.memoryBytes}`,
    `activeTaskExecutions=${tasks.activeCount}`,
    `activeDebugSessions=${debug.activeCount}`,
    `deferredWorkflowConfigurations=${deferredConfigurations.length}`,
    `profileName=unavailable-stable-api`,
    `allOutputSources=unavailable-stable-api`,
    `installationHealthy=${installationHealthy}`,
    `runtimeHealthy=${runtimeHealthy}`,
    `doctorHealthy=${healthy}`,
  ];
  output.info(`Doctor report:\n${lines.join("\n")}`);
  output.show(true);
  const deferredConfiguration = deferredConfigurations.find((result) => result.uri !== null);
  if (deferredConfiguration?.uri) {
    const choice = await vscode.window.showWarningMessage(
      "An existing workspace Task or workspace file contains folder-open deferred execution. The Bridge does not alter it automatically.",
      "Open Configuration",
    );
    if (choice === "Open Configuration") {
      await vscode.window.showTextDocument(vscode.Uri.parse(deferredConfiguration.uri));
    }
  }
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
