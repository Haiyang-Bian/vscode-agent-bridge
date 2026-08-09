import * as vscode from "vscode";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import { BridgeHost } from "./bridge-host.js";
import { CodexConfigConflictError, createManagedConfigBlock } from "./codex-config.js";
import {
  configureCodexIntegration,
  inspectInstallation,
  removeCodexIntegration,
  resolveCodexConfigPath,
  resolveInstalledExecutablePath,
} from "./installation.js";

let activeHost: BridgeHost | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("VS Code Agent Bridge", { log: true });
  const host = new BridgeHost(output);
  activeHost = host;

  await host.start();

  context.subscriptions.push(
    output,
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
    vscode.commands.registerCommand("vscodeAgentBridge.removeCodexConfiguration", async () => {
      await removeCodexCommand(output);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.runDoctor", async () => {
      await runDoctorCommand(context, host, output);
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

export async function deactivate(): Promise<void> {
  const host = activeHost;
  activeHost = undefined;
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

async function runDoctorCommand(
  context: vscode.ExtensionContext,
  host: BridgeHost,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const report = await inspectInstallation(context);
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
    `remoteContext=${vscode.env.remoteName ? "unsupported" : "local"}`,
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
