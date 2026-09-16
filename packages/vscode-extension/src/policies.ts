import * as vscode from "vscode";

import { BridgeError } from "@vscode-agent-bridge/protocol";

const CONFIGURATION_SECTION = "vscodeAgentBridge";

export interface BridgePolicyState {
  readonly enabled: boolean;
  readonly workspaceTrusted: boolean;
  readonly remote: boolean;
  readonly publishAllowed: boolean;
}

export function getBridgePolicyState(): BridgePolicyState {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const enabled = configuration.get<boolean>("enabled", true);
  const workspaceTrusted = vscode.workspace.isTrusted;
  const remote = Boolean(vscode.env.remoteName);
  return {
    enabled,
    workspaceTrusted,
    remote,
    publishAllowed: enabled && workspaceTrusted && !remote,
  };
}

export function canCaptureTerminalSensitiveData(): boolean {
  return getBridgePolicyState().publishAllowed;
}

export function assertAgentWriteAllowed(): void {
  const policy = getBridgePolicyState();
  if (!policy.enabled) {
    throw new BridgeError(
      "BRIDGE_DISABLED",
      "VS Code Agent Bridge is disabled for this machine.",
    );
  }
  if (policy.remote) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote document mutation is not supported.");
  }
  if (!policy.workspaceTrusted) {
    throw new BridgeError(
      "WORKSPACE_UNTRUSTED",
      "Trust the workspace before an Agent prepares or applies document changes.",
    );
  }
}

export function assertTerminalMetadataAllowed(): "full" {
  assertPublishedBridgeAccess();
  return "full";
}

export function assertTerminalExecutionAccess(): void {
  assertPublishedBridgeAccess();
}

function assertPublishedBridgeAccess(): void {
  const policy = getBridgePolicyState();
  if (!policy.enabled) {
    throw new BridgeError("BRIDGE_DISABLED", "VS Code Agent Bridge is not currently published.");
  }
  if (policy.remote) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote VS Code terminal routing is unsupported.");
  }
  if (!policy.workspaceTrusted) {
    throw new BridgeError("WORKSPACE_UNTRUSTED", "Terminal observation requires a trusted workspace.");
  }
}
