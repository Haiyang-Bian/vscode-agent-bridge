import * as vscode from "vscode";

import { BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import type { BridgeHost } from "./bridge-host.js";
import type { DebugManager } from "./debug-manager.js";
import type { ExtensionAwarenessManager } from "./extension-awareness-manager.js";
import { inspectInstallation } from "./installation.js";
import { LegacyExperimentData } from "./legacy-experiment-data.js";
import {
  clearLocalUsageInsights,
  createLocalUsageInsightsReport,
  readLocalUsageInsights,
} from "./local-usage-insights.js";
import type { TaskManager } from "./task-manager.js";
import type { TerminalObserver } from "./terminal-observer.js";

const STATUS_VIEW_ID = "vscodeAgentBridge.statusView";

interface HubDependencies {
  readonly host: BridgeHost;
  readonly terminals: TerminalObserver;
  readonly tasks: TaskManager;
  readonly debug: DebugManager;
  readonly extensionAwareness: ExtensionAwarenessManager;
  readonly legacyData: LegacyExperimentData;
}

interface HubNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly command?: vscode.Command;
}

export function registerBridgeHubUi(
  context: vscode.ExtensionContext,
  dependencies: HubDependencies,
): void {
  const status = new StatusTreeProvider(context, dependencies);
  const refresh = (): void => status.refresh();
  context.subscriptions.push(
    status,
    vscode.window.registerTreeDataProvider(STATUS_VIEW_ID, status),
    vscode.commands.registerCommand("vscodeAgentBridge.refreshHub", refresh),
    vscode.commands.registerCommand("vscodeAgentBridge.openLegacyExperimentData", () =>
      dependencies.legacyData.openLocation(),
    ),
    vscode.commands.registerCommand("vscodeAgentBridge.deleteLegacyExperimentData", async () => {
      const deleted = await dependencies.legacyData.deleteInteractively();
      refresh();
      if (deleted) await vscode.window.showInformationMessage("Legacy Bridge experiment data was deleted.");
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.clearUsageInsights", async () => {
      const confirmation = await vscode.window.showWarningMessage(
        "Clear all local VS Code Agent Bridge usage insight events? This cannot be undone.",
        { modal: true },
        "Clear Local Insights",
      );
      if (confirmation !== "Clear Local Insights") return;
      const removed = await clearLocalUsageInsights();
      refresh();
      await vscode.window.showInformationMessage(`Cleared ${removed} local insight file(s).`);
    }),
    vscode.commands.registerCommand("vscodeAgentBridge.exportUsageInsights", async () => {
      const target = await vscode.window.showSaveDialog({
        title: "Export privacy-preserving Bridge usage insights",
        defaultUri: vscode.Uri.file("vscode-agent-bridge-usage-insights.json"),
        filters: { JSON: ["json"] },
      });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(await createLocalUsageInsightsReport(), "utf8"));
      await vscode.window.showInformationMessage("Exported the aggregate local usage insight report.");
    }),
    vscode.languages.onDidChangeDiagnostics(refresh),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    vscode.debug.onDidStartDebugSession(refresh),
    vscode.debug.onDidTerminateDebugSession(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
  );
}

class StatusTreeProvider implements vscode.TreeDataProvider<HubNode>, vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #dependencies: HubDependencies;
  readonly #emitter = new vscode.EventEmitter<HubNode | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(context: vscode.ExtensionContext, dependencies: HubDependencies) {
    this.#context = context;
    this.#dependencies = dependencies;
  }

  refresh(): void {
    this.#emitter.fire(undefined);
  }

  getTreeItem(node: HubNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description !== undefined) item.description = node.description;
    item.tooltip = node.tooltip ?? [node.label, node.description].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(node.icon ?? "circle-outline");
    if (node.command !== undefined) item.command = node.command;
    return item;
  }

  async getChildren(): Promise<HubNode[]> {
    const { host, terminals, tasks, debug, extensionAwareness, legacyData } = this.#dependencies;
    const [installation, legacy, insights] = await Promise.all([
      inspectInstallation(this.#context).catch(() => null),
      legacyData.exists(),
      readLocalUsageInsights(30),
    ]);
    const problems = vscode.languages.getDiagnostics()
      .reduce((total, [, diagnostics]) => total + diagnostics.length, 0);
    const terminalStats = terminals.getStats();
    const awarenessStats = extensionAwareness.getStats();
    const nodes: HubNode[] = [
      {
        label: "Bridge instance",
        description: host.isListening ? "published" : "not published",
        tooltip: `Extension ${BRIDGE_RELEASE_VERSION} · protocol v${BRIDGE_PROTOCOL_VERSION}`,
        icon: host.isListening ? "radio-tower" : "debug-disconnect",
      },
      {
        label: "Shared service and Codex",
        description: installation?.codexConfig ?? "unavailable",
        icon: installation?.codexConfig === "current" ? "pass" : "warning",
      },
      {
        label: "Workspace",
        description: `${vscode.workspace.isTrusted ? "trusted" : "untrusted"}${vscode.env.remoteName ? " · remote" : " · local"}`,
        icon: vscode.workspace.isTrusted ? "shield" : "lock",
      },
      { label: "Problems", description: String(problems), icon: problems > 0 ? "warning" : "pass" },
      {
        label: "IDE state",
        description: `${awarenessStats.activeExtensions}/${awarenessStats.installedExtensions} extensions · ${awarenessStats.visibleOutputSources} visible output`,
        tooltip: "VS Code stable APIs do not expose the current Profile name or every Output channel.",
        icon: "pulse",
      },
      {
        label: "Terminals",
        description: `${terminalStats.terminalCount} terminal(s) · ${terminalStats.executionCount} captured execution(s)`,
        icon: "terminal",
      },
      { label: "Tasks", description: `${tasks.activeCount} active`, icon: "tools" },
      { label: "Debug", description: `${debug.activeCount} active`, icon: "debug-alt" },
      {
        label: "Usage insights",
        description: `${insights.totalCalls} call(s) in 30 days`,
        icon: "graph",
        command: { command: "vscodeAgentBridge.exportUsageInsights", title: "Export usage insights" },
      },
      {
        label: "Doctor",
        description: "Run installation and Bridge checks",
        icon: "stethoscope",
        command: { command: "vscodeAgentBridge.runDoctor", title: "Run Doctor" },
      },
    ];
    if (legacy) {
      nodes.push({
        label: "Legacy experiment data",
        description: "preserved and not loaded",
        tooltip: "Open the data location or use the command palette to delete only Bridge-owned legacy metadata and snapshots.",
        icon: "archive",
        command: { command: "vscodeAgentBridge.openLegacyExperimentData", title: "Open legacy data" },
      });
    }
    return nodes;
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}
