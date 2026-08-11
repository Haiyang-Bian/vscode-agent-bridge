import * as vscode from "vscode";

import {
  BridgeError,
  BridgeExecutionModeSchema,
  type BridgeExecutionMode,
} from "@vscode-agent-bridge/protocol";

const CONFIGURATION_SECTION = "vscodeAgentBridge";

export interface BridgePolicyState {
  readonly enabled: boolean;
  readonly executionMode: BridgeExecutionMode;
  readonly legacyAggressiveExecutionMode: boolean;
  readonly legacyMigrationRequired: boolean;
  readonly workspaceTrusted: boolean;
  readonly remote: boolean;
  readonly publishAllowed: boolean;
}

export function getBridgePolicyState(): BridgePolicyState {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const enabledInspection = configuration.inspect<boolean>("enabled");
  const explicitlySelected = enabledInspection?.globalValue !== undefined;
  const legacyMigrationRequired = !explicitlySelected && hasRestrictiveLegacyConfiguration(configuration);
  const enabled = configuration.get<boolean>("enabled", true);
  const legacyAggressiveExecutionMode = configuration.inspect<unknown>("executionMode")?.globalValue === "aggressive";
  const executionMode = BridgeExecutionModeSchema.catch("explicit").parse(
    configuration.get<unknown>("executionMode", "explicit"),
  );
  const workspaceTrusted = vscode.workspace.isTrusted;
  const remote = Boolean(vscode.env.remoteName);
  return {
    enabled,
    executionMode,
    legacyAggressiveExecutionMode,
    legacyMigrationRequired,
    workspaceTrusted,
    remote,
    publishAllowed: enabled && !legacyMigrationRequired && workspaceTrusted && !remote,
  };
}

export function getExecutionMode(): BridgeExecutionMode {
  return getBridgePolicyState().executionMode;
}

export function canCaptureTerminalSensitiveData(): boolean {
  return getBridgePolicyState().publishAllowed;
}

export function assertAgentWriteAllowed(): void {
  const policy = getBridgePolicyState();
  if (!policy.enabled || policy.legacyMigrationRequired) {
    throw new BridgeError(
      policy.legacyMigrationRequired ? "POLICY_DENIED" : "BRIDGE_DISABLED",
      policy.legacyMigrationRequired
        ? "A restrictive pre-v0.7 policy requires an explicit bridge migration choice."
        : "VS Code Agent Bridge is disabled for this machine.",
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
  if (!policy.enabled || policy.legacyMigrationRequired) {
    throw new BridgeError("BRIDGE_DISABLED", "VS Code Agent Bridge is not currently published.");
  }
  if (policy.remote) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote VS Code terminal routing is unsupported.");
  }
  if (!policy.workspaceTrusted) {
    throw new BridgeError("WORKSPACE_UNTRUSTED", "Terminal observation requires a trusted workspace.");
  }
}

function hasRestrictiveLegacyConfiguration(
  configuration: vscode.WorkspaceConfiguration,
): boolean {
  const autonomy = configuration.inspect<string>("autonomyProfile")?.globalValue;
  const terminal = configuration.inspect<string>("terminalReadPolicy")?.globalValue;
  return autonomy === "readOnly" || autonomy === "review" || terminal === "metadataOnly" || terminal === "deny";
}
