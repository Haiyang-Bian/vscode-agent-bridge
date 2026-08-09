import * as vscode from "vscode";

import {
  AutonomyProfileSchema,
  BridgeError,
  TerminalReadPolicySchema,
  type AutonomyProfile,
  type TerminalReadPolicy,
} from "@vscode-agent-bridge/protocol";

const CONFIGURATION_SECTION = "vscodeAgentBridge";

export function getAutonomyProfile(): AutonomyProfile {
  const value = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get<unknown>("autonomyProfile", "autonomous");
  return AutonomyProfileSchema.catch("autonomous").parse(value);
}

export function getTerminalReadPolicy(): TerminalReadPolicy {
  const value = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get<unknown>("terminalReadPolicy", "allow");
  return TerminalReadPolicySchema.catch("allow").parse(value);
}

export function assertAgentWriteAllowed(): void {
  if (getAutonomyProfile() === "readOnly") {
    throw new BridgeError("POLICY_DENIED", "Agent writes are disabled by the read-only policy.");
  }
  if (vscode.env.remoteName) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote document mutation is not supported.");
  }
  if (!vscode.workspace.isTrusted) {
    throw new BridgeError(
      "WORKSPACE_UNTRUSTED",
      "Trust the workspace before an Agent prepares or applies document changes.",
    );
  }
}

export function assertTerminalMetadataAllowed(): "full" | "metadata" {
  if (vscode.env.remoteName) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote VS Code terminal routing is unsupported.");
  }
  if (getTerminalReadPolicy() === "deny") {
    throw new BridgeError("POLICY_DENIED", "Terminal observation is disabled by policy.");
  }
  return getTerminalReadPolicy() === "allow" && vscode.workspace.isTrusted ? "full" : "metadata";
}

export function assertTerminalExecutionAccess(): void {
  if (vscode.env.remoteName) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote VS Code terminal routing is unsupported.");
  }
  if (getTerminalReadPolicy() !== "allow") {
    throw new BridgeError(
      "POLICY_DENIED",
      "Terminal execution details are disabled by the active terminal read policy.",
    );
  }
  if (!vscode.workspace.isTrusted) {
    throw new BridgeError(
      "POLICY_DENIED",
      "Terminal execution details are unavailable in an untrusted workspace.",
    );
  }
}
