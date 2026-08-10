import * as vscode from "vscode";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { WorkspaceOnboardingService } from "./workspace-onboarding.js";

export class AgentEditorVisibility {
  readonly #onboarding: WorkspaceOnboardingService;

  constructor(onboarding: WorkspaceOnboardingService) {
    this.#onboarding = onboarding;
  }

  async reveal(rootUri: string, targetUris: readonly vscode.Uri[]): Promise<void> {
    const unique = [...new Map(targetUris.map((uri) => [uri.toString(true), uri])).values()];
    if (unique.length === 0) {
      return;
    }
    const root = vscode.Uri.parse(rootUri, true);
    const policy = this.#onboarding.getEditVisibility(root);
    if (policy === "off") {
      return;
    }

    try {
      const documents = await Promise.all(
        (policy === "firstOnly" ? unique.slice(0, 1) : unique).map((uri) =>
          vscode.workspace.openTextDocument(uri),
        ),
      );
      if (policy === "focusEach") {
        for (const document of documents) {
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
        }
        return;
      }
      if (policy === "focusFirst") {
        for (const document of documents.slice(1)) {
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
        }
      }
      await vscode.window.showTextDocument(documents[0]!, {
        preview: false,
        preserveFocus: false,
      });
    } catch {
      throw new BridgeError(
        "EDITOR_REVEAL_FAILED",
        "VS Code could not open every configured Agent edit target before mutation.",
      );
    }
  }
}
