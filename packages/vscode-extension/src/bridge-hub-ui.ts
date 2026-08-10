import * as vscode from "vscode";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  MCP_TOOL_CATALOG,
  MCP_TOOL_DOMAINS,
  type McpToolCatalogEntry,
  type McpToolDomain,
  type UsageInsightsResult,
} from "@vscode-agent-bridge/protocol";

import type { BridgeHost } from "./bridge-host.js";
import type { DebugManager } from "./debug-manager.js";
import type { ExperimentManager } from "./experiment-manager.js";
import { inspectInstallation } from "./installation.js";
import {
  clearLocalUsageInsights,
  createLocalUsageInsightsReport,
  readLocalUsageInsights,
} from "./local-usage-insights.js";
import type { TaskManager } from "./task-manager.js";
import type { TerminalObserver } from "./terminal-observer.js";

const OVERVIEW_VIEW_ID = "vscodeAgentBridge.overviewView";
const CAPABILITIES_VIEW_ID = "vscodeAgentBridge.capabilitiesView";
const INSIGHTS_VIEW_ID = "vscodeAgentBridge.usageInsightsView";

interface HubDependencies {
  readonly host: BridgeHost;
  readonly experiments: ExperimentManager;
  readonly terminals: TerminalObserver;
  readonly tasks: TaskManager;
  readonly debug: DebugManager;
}

interface HubNode {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
}

type CapabilityNode =
  | { readonly kind: "domain"; readonly domain: McpToolDomain }
  | { readonly kind: "tool"; readonly tool: McpToolCatalogEntry };

export function registerBridgeHubUi(
  context: vscode.ExtensionContext,
  dependencies: HubDependencies,
): void {
  const overview = new OverviewTreeProvider(context, dependencies);
  const capabilities = new CapabilitiesTreeProvider();
  const insights = new UsageInsightsTreeProvider();
  const refresh = (): void => {
    overview.refresh();
    insights.refresh();
  };

  context.subscriptions.push(
    overview,
    capabilities,
    insights,
    vscode.window.registerTreeDataProvider(OVERVIEW_VIEW_ID, overview),
    vscode.window.registerTreeDataProvider(CAPABILITIES_VIEW_ID, capabilities),
    vscode.window.registerTreeDataProvider(INSIGHTS_VIEW_ID, insights),
    vscode.commands.registerCommand("vscodeAgentBridge.refreshHub", refresh),
    vscode.commands.registerCommand("vscodeAgentBridge.clearUsageInsights", async () => {
      const confirmation = await vscode.window.showWarningMessage(
        "Clear all local VS Code Agent Bridge usage insight events? This cannot be undone.",
        { modal: true },
        "Clear Local Insights",
      );
      if (confirmation !== "Clear Local Insights") return;
      const removed = await clearLocalUsageInsights();
      insights.refresh();
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
    dependencies.experiments.onDidChange(refresh),
    vscode.languages.onDidChangeDiagnostics(refresh),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    vscode.debug.onDidStartDebugSession(refresh),
    vscode.debug.onDidTerminateDebugSession(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
  );
}

class OverviewTreeProvider implements vscode.TreeDataProvider<HubNode>, vscode.Disposable {
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
    return item;
  }

  async getChildren(): Promise<HubNode[]> {
    const { host, experiments, terminals, tasks, debug } = this.#dependencies;
    const installation = await inspectInstallation(this.#context).catch(() => null);
    const activeExperiment = await experiments.getActiveExperiment().catch(() => null);
    const problems = vscode.languages
      .getDiagnostics()
      .reduce((total, [, diagnostics]) => total + diagnostics.length, 0);
    const terminalStats = terminals.getStats();
    return [
      {
        label: "Bridge",
        description: host.isListening ? "published" : "not published",
        tooltip: `VS Code Agent Bridge ${BRIDGE_RELEASE_VERSION} · protocol v${BRIDGE_PROTOCOL_VERSION}`,
        icon: host.isListening ? "radio-tower" : "debug-disconnect",
      },
      {
        label: "Codex configuration",
        description: installation?.codexConfig ?? "unavailable",
        icon: installation?.codexConfig === "current" ? "pass" : "warning",
      },
      {
        label: "Workspace",
        description: `${vscode.workspace.isTrusted ? "trusted" : "untrusted"}${vscode.env.remoteName ? " · remote" : " · local"}`,
        icon: vscode.workspace.isTrusted ? "shield" : "lock",
      },
      {
        label: "Experiment",
        description: activeExperiment?.title ?? "none active",
        icon: activeExperiment ? "beaker" : "circle-outline",
      },
      { label: "Problems", description: String(problems), icon: problems > 0 ? "warning" : "pass" },
      {
        label: "Terminals",
        description: `${terminalStats.terminalCount} terminal(s) · ${terminalStats.executionCount} captured execution(s)`,
        tooltip: `Captured output memory: ${terminalStats.memoryBytes} byte(s)`,
        icon: "terminal",
      },
      { label: "Tasks", description: `${tasks.activeCount} active`, icon: "tools" },
      { label: "Debug", description: `${debug.activeCount} active`, icon: "debug-alt" },
    ];
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

class CapabilitiesTreeProvider
  implements vscode.TreeDataProvider<CapabilityNode>, vscode.Disposable
{
  readonly #emitter = new vscode.EventEmitter<CapabilityNode | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;

  getTreeItem(node: CapabilityNode): vscode.TreeItem {
    if (node.kind === "domain") {
      const count = MCP_TOOL_CATALOG.filter((tool) => tool.domain === node.domain).length;
      const item = new vscode.TreeItem(
        MCP_TOOL_DOMAINS[node.domain],
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${count} tool(s)`;
      item.iconPath = new vscode.ThemeIcon("symbol-namespace");
      return item;
    }
    const item = new vscode.TreeItem(node.tool.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${node.tool.intent} · ${node.tool.recoverability}`;
    item.tooltip = [
      `Side effects: ${node.tool.sideEffectScope}`,
      `Experiment required: ${node.tool.requiresExperiment}`,
      `Open world: ${node.tool.openWorld}`,
      `Sensitivity: ${node.tool.sensitivity}`,
    ].join("\n");
    item.iconPath = new vscode.ThemeIcon(node.tool.annotations.readOnlyHint ? "eye" : "edit");
    return item;
  }

  getChildren(node?: CapabilityNode): CapabilityNode[] {
    if (!node) {
      return (Object.keys(MCP_TOOL_DOMAINS) as McpToolDomain[]).map((domain) => ({
        kind: "domain",
        domain,
      }));
    }
    return node.kind === "domain"
      ? MCP_TOOL_CATALOG.filter((tool) => tool.domain === node.domain).map((tool) => ({
          kind: "tool",
          tool,
        }))
      : [];
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

class UsageInsightsTreeProvider
  implements vscode.TreeDataProvider<HubNode>, vscode.Disposable
{
  readonly #emitter = new vscode.EventEmitter<HubNode | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;

  refresh(): void {
    this.#emitter.fire(undefined);
  }

  getTreeItem(node: HubNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    if (node.description !== undefined) item.description = node.description;
    item.tooltip = node.tooltip ?? [node.label, node.description].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(node.icon ?? "graph");
    return item;
  }

  async getChildren(): Promise<HubNode[]> {
    const insights = await readLocalUsageInsights(30);
    return insightNodes(insights);
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function insightNodes(insights: UsageInsightsResult): HubNode[] {
  if (insights.totalCalls === 0) {
    return [{ label: "No local MCP calls recorded", description: "30-day window", icon: "info" }];
  }
  return [
    { label: "Calls", description: String(insights.totalCalls), icon: "pulse" },
    ...insights.categories.slice(0, 7).map((entry) => ({
      label: MCP_TOOL_DOMAINS[entry.name as McpToolDomain] ?? entry.name,
      description: String(entry.count),
      icon: "symbol-namespace",
    })),
    ...insights.friction.slice(0, 5).map((entry) => ({
      label: entry.name,
      description: `${entry.count} friction event(s)`,
      icon: "warning",
    })),
    ...insights.suggestions.map((suggestion) => ({
      label: suggestion,
      tooltip: suggestion,
      icon: "lightbulb",
    })),
  ];
}
