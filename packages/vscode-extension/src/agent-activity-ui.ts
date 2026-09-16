import * as vscode from "vscode";

import {
  AgentActivityTracker,
  type AgentActivityEntry,
} from "./agent-activity.js";

const VIEW_ID = "vscodeAgentBridge.agentActivityView";

export function registerAgentActivityUi(
  context: vscode.ExtensionContext,
  tracker: AgentActivityTracker,
): void {
  const provider = new AgentActivityTreeProvider(tracker);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  status.command = `${VIEW_ID}.focus`;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshStatus = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
    const running = tracker.entries.find(
      (entry) => entry.status === "queued" || entry.status === "running",
    );
    if (running) {
      status.text = `$(sync~spin) Agent: ${running.title}`;
      status.tooltip = `${running.toolName} · ${running.status}`;
      status.show();
      return;
    }
    const latest = tracker.entries[0];
    if (!latest) {
      status.hide();
      return;
    }
    status.text = `$(pulse) Agent: ${latest.status}`;
    status.tooltip = `${latest.title} · ${latest.toolName}`;
    status.show();
    hideTimer = setTimeout(() => status.hide(), 5_000);
  };

  const subscription = tracker.subscribe(() => {
    provider.refresh();
    refreshStatus();
  });
  context.subscriptions.push(
    provider,
    status,
    subscription,
    vscode.window.registerTreeDataProvider(VIEW_ID, provider),
    vscode.commands.registerCommand("vscodeAgentBridge.revealAgentActivity", async (operationId: string) => {
      const entry = tracker.find(operationId);
      const location = entry?.locations[0];
      if (!location) return;
      if (location.kind === "uri") {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(location.uri, true));
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        if (location.line !== undefined) {
          const position = new vscode.Position(location.line, location.character ?? 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
        }
        return;
      }
      await vscode.commands.executeCommand(
        location.kind === "debug" ? "workbench.view.debug" : "workbench.action.terminal.focus",
      );
    }),
    new vscode.Disposable(() => {
      if (hideTimer) {
        clearTimeout(hideTimer);
      }
    }),
  );
}

class AgentActivityTreeProvider
  implements vscode.TreeDataProvider<AgentActivityEntry>, vscode.Disposable
{
  readonly #tracker: AgentActivityTracker;
  readonly #emitter = new vscode.EventEmitter<AgentActivityEntry | undefined>();
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(tracker: AgentActivityTracker) {
    this.#tracker = tracker;
  }

  refresh(): void {
    this.#emitter.fire(undefined);
  }

  getTreeItem(entry: AgentActivityEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
    item.description = `${entry.status} · ${entry.toolName}`;
    item.tooltip = [
      entry.reason,
      entry.targets.length > 0 ? `Targets: ${entry.targets.join(", ")}` : null,
      entry.editCount === null ? null : `Edits: ${entry.editCount}`,
      entry.errorCode ? `Error: ${entry.errorCode}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    item.iconPath = new vscode.ThemeIcon(iconForStatus(entry.status));
    if (entry.locations.length > 0) {
      item.command = {
        command: "vscodeAgentBridge.revealAgentActivity",
        title: "Reveal activity target",
        arguments: [entry.operationId],
      };
    }
    return item;
  }

  getChildren(): AgentActivityEntry[] {
    return [...this.#tracker.entries];
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function iconForStatus(status: AgentActivityEntry["status"]): string {
  switch (status) {
    case "queued":
    case "running":
      return "sync";
    case "succeeded":
      return "pass";
    case "no-op":
      return "circle-outline";
    case "rejected":
      return "shield";
    case "failed":
      return "error";
  }
}
