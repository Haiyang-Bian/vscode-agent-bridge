import * as vscode from "vscode";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { WorkspaceOnboardingService } from "./workspace-onboarding.js";
import { planEditorReveal } from "./editor-visibility-plan.js";

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
    const revealPlan = planEditorReveal(policy, unique);
    if (revealPlan.length === 0) {
      return;
    }

    try {
      const documents = new Map(
        await Promise.all(
          revealPlan.map(async ({ target }) => [
            target.toString(true),
            await vscode.workspace.openTextDocument(target),
          ] as const),
        ),
      );
      for (const step of revealPlan) {
        await vscode.window.showTextDocument(documents.get(step.target.toString(true))!, {
          preview: false,
          preserveFocus: step.preserveFocus,
        });
      }
    } catch {
      throw new BridgeError(
        "EDITOR_REVEAL_FAILED",
        "VS Code could not open every configured Agent edit target before mutation.",
      );
    }
  }
}
