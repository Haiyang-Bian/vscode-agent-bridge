import * as vscode from "vscode";

import { BridgeHost } from "./bridge-host.js";

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
}

export async function deactivate(): Promise<void> {
  const host = activeHost;
  activeHost = undefined;
  await host?.stop();
}
