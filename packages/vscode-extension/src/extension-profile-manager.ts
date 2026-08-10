import * as vscode from "vscode";

import {
  BridgeError,
  type ExtensionConfigurationResult,
  type ExtensionConfigurationTarget,
  type GetExtensionConfigurationParams,
  type UpdateExtensionConfigurationParams,
  type UpdateExtensionConfigurationResult,
} from "@vscode-agent-bridge/protocol";

import { ExperimentManager } from "./experiment-manager.js";
import {
  GlobalProfileChangeJournal,
  assertConfigurationKeyAllowed,
  assertConfigurationTargetAllowed,
  assertConfigurationValueAllowed,
  configurationValueSha256,
  findDeclaredConfigurationSetting,
} from "./extension-profile-core.js";

export class ExtensionProfileManager {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;
  readonly #journal: GlobalProfileChangeJournal;

  constructor(instanceId: string, experiments: ExperimentManager, globalStorageUri: vscode.Uri) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
    this.#journal = new GlobalProfileChangeJournal(globalStorageUri.fsPath);
  }

  getConfiguration(params: GetExtensionConfigurationParams): ExtensionConfigurationResult {
    const { extension, setting } = resolveDeclaredSetting(params.extensionId, params.key);
    assertConfigurationKeyAllowed(params.key);
    assertConfigurationTargetAllowed(setting, params.target);
    const root = resolveOptionalRoot(params.rootUri, params.target);
    const configuration = vscode.workspace.getConfiguration(undefined, root?.uri);
    const inspection = configuration.inspect<unknown>(params.key);
    if (!inspection) {
      throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "VS Code did not expose this declared setting.");
    }
    const effectiveValue = configuration.get<unknown>(params.key);
    const targetValue = targetValueFromInspection(inspection, params.target);
    return {
      instanceId: this.#instanceId,
      extensionId: extension.id,
      key: params.key,
      target: params.target,
      rootUri: root?.uri.toString(true) ?? null,
      declaredTypes: [...setting.types],
      scope: setting.scope,
      effectiveValue: effectiveValue === undefined ? null : effectiveValue,
      effectiveValueDefined: effectiveValue !== undefined,
      targetValue: targetValue === undefined ? null : targetValue,
      targetValueSha256: configurationValueSha256(targetValue),
      targetValueDefined: targetValue !== undefined,
      sensitive: false,
    };
  }

  async updateConfiguration(
    params: UpdateExtensionConfigurationParams,
  ): Promise<UpdateExtensionConfigurationResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The configuration target is outside the active experiment root.");
    }
    const { extension, setting } = resolveDeclaredSetting(params.extensionId, params.key);
    assertConfigurationKeyAllowed(params.key);
    assertConfigurationTargetAllowed(setting, params.target);
    assertConfigurationValueAllowed(setting, params.newValue);
    const root = resolveRequiredRoot(params.rootUri);
    const configuration = vscode.workspace.getConfiguration(undefined, root.uri);
    const inspection = configuration.inspect<unknown>(params.key);
    if (!inspection) {
      throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "VS Code did not expose this declared setting.");
    }
    const beforeValue = targetValueFromInspection(inspection, params.target);
    const beforeSha256 = configurationValueSha256(beforeValue);
    if (beforeSha256 !== params.expectedValueSha256) {
      throw new BridgeError("EXTENSION_CONFIGURATION_STALE", "The extension configuration changed after it was read.");
    }
    const nextSha256 = configurationValueSha256(params.newValue, true);
    if (beforeSha256 === nextSha256) {
      return result(this.#instanceId, params, extension.id, false, nextSha256, null, null);
    }

    if (params.target === "global") {
      await updateSetting(configuration, params.key, params.newValue, vscode.ConfigurationTarget.Global);
      const change = await this.#journal.append({
        extensionId: extension.id,
        key: params.key,
        beforeDefined: beforeValue !== undefined,
        beforeValue: beforeValue === undefined ? null : beforeValue,
        afterValueSha256: nextSha256,
      });
      return result(this.#instanceId, params, extension.id, true, nextSha256, null, change.changeId);
    }

    const settingsUri = configurationTargetUri(root.uri, params.target);
    await this.#experiments.captureBeforeResourceApply(params.sessionId, [settingsUri]);
    try {
      await updateSetting(
        configuration,
        params.key,
        params.newValue,
        params.target === "workspace"
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.WorkspaceFolder,
      );
    } catch {
      throw new BridgeError(
        "EXTENSION_CONFIGURATION_DENIED",
        "VS Code rejected the declared extension configuration update.",
      );
    }
    const checkpointId = await this.#experiments.captureAfterAgentApply(
      params.sessionId,
      params.reason,
      [settingsUri],
    );
    return result(this.#instanceId, params, extension.id, true, nextSha256, checkpointId, null);
  }

  async undoLastGlobalChange(): Promise<boolean> {
    const change = await this.#journal.latest();
    if (!change) return false;
    const { setting } = resolveDeclaredSetting(change.extensionId, change.key);
    assertConfigurationKeyAllowed(change.key);
    assertConfigurationTargetAllowed(setting, "global");
    const configuration = vscode.workspace.getConfiguration();
    const inspection = configuration.inspect<unknown>(change.key);
    if (!inspection || configurationValueSha256(inspection.globalValue) !== change.afterValueSha256) {
      throw new BridgeError(
        "EXTENSION_CONFIGURATION_STALE",
        "The current Global Profile value changed after the recorded Agent update.",
      );
    }
    await updateSetting(
      configuration,
      change.key,
      change.beforeDefined ? change.beforeValue : undefined,
      vscode.ConfigurationTarget.Global,
    );
    await this.#journal.remove(change.changeId);
    return true;
  }
}

function resolveDeclaredSetting(extensionId: string, key: string) {
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) throw new BridgeError("EXTENSION_NOT_FOUND", "The requested extension is not installed.");
  const setting = findDeclaredConfigurationSetting(extension.packageJSON, key);
  if (!setting) {
    throw new BridgeError("EXTENSION_CONFIGURATION_DENIED", "The extension manifest does not declare this configuration key.");
  }
  return { extension, setting };
}

function targetValueFromInspection(
  inspection: ReturnType<vscode.WorkspaceConfiguration["inspect"]> extends infer Value ? Value : never,
  target: ExtensionConfigurationTarget,
): unknown {
  if (!inspection) return undefined;
  if (target === "global") return inspection.globalValue;
  if (target === "workspace") return inspection.workspaceValue;
  return inspection.workspaceFolderValue;
}

function resolveOptionalRoot(
  rootUri: string | undefined,
  target: ExtensionConfigurationTarget,
): vscode.WorkspaceFolder | undefined {
  if (!rootUri) {
    if (target !== "global") {
      throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Workspace configuration requires an explicit root URI.");
    }
    return undefined;
  }
  return resolveRequiredRoot(rootUri);
}

function resolveRequiredRoot(rootUri: string): vscode.WorkspaceFolder {
  const root = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === "file" && folder.uri.toString(true) === rootUri,
  );
  if (!root) throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The requested local workspace root is unavailable.");
  return root;
}

function configurationTargetUri(root: vscode.Uri, target: ExtensionConfigurationTarget): vscode.Uri {
  if (target === "workspace" && vscode.workspace.workspaceFile?.scheme === "file") {
    return vscode.workspace.workspaceFile;
  }
  return vscode.Uri.joinPath(root, ".vscode", "settings.json");
}

async function updateSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget,
): Promise<void> {
  try {
    await configuration.update(key, value, target, false);
  } catch {
    throw new BridgeError(
      "EXTENSION_CONFIGURATION_DENIED",
      "VS Code rejected the declared extension configuration update.",
    );
  }
}

function result(
  instanceId: string,
  params: UpdateExtensionConfigurationParams,
  extensionId: string,
  changed: boolean,
  valueSha256: string,
  checkpointId: string | null,
  globalChangeId: string | null,
): UpdateExtensionConfigurationResult {
  return {
    instanceId,
    sessionId: params.sessionId,
    extensionId,
    key: params.key,
    target: params.target,
    changed,
    valueSha256,
    checkpointId,
    globalChangeId,
    recoverability: params.target === "global" ? "globalJournal" : "experiment",
    updatedAt: new Date().toISOString(),
  };
}
