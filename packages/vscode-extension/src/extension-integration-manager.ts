import * as vscode from "vscode";

import { PythonExtension, type ResolvedEnvironment } from "@vscode/python-extension";
import {
  BridgeError,
  PYTHON_ENVIRONMENT_INTEGRATION_ID,
  PYTHON_EXTENSION_ID,
  type ExtensionIntegrationStateResult,
  type GetExtensionIntegrationStateParams,
  type ListExtensionIntegrationsParams,
  type ListExtensionIntegrationsResult,
} from "@vscode-agent-bridge/protocol";

import {
  EXTENSION_INTEGRATION_CATALOG,
  describeExtensionIntegration,
  getExtensionIntegrationDescriptor,
  isPythonExtensionVersionSupported,
} from "./extension-integration-registry.js";
import { normalizeReviewedPythonEnvironment } from "./python-environment-integration-core.js";

export class ExtensionIntegrationManager {
  readonly #instanceId: string;

  constructor(instanceId: string) {
    this.#instanceId = instanceId;
  }

  list(params: ListExtensionIntegrationsParams): ListExtensionIntegrationsResult {
    const integrations = EXTENSION_INTEGRATION_CATALOG.map((descriptor) => {
      const extension = vscode.extensions.getExtension(descriptor.extensionId);
      return describeExtensionIntegration(descriptor, extensionVersion(extension));
    });
    const page = integrations.slice(params.offset, params.offset + params.limit);
    return {
      instanceId: this.#instanceId,
      integrations: page,
      returnedCount: page.length,
      totalCount: integrations.length,
      truncated: params.offset + page.length < integrations.length,
    };
  }

  async getState(
    params: GetExtensionIntegrationStateParams,
  ): Promise<ExtensionIntegrationStateResult> {
    const descriptor = getExtensionIntegrationDescriptor(params.integrationId);
    if (!descriptor || descriptor.integrationId !== PYTHON_ENVIRONMENT_INTEGRATION_ID) {
      throw new BridgeError(
        "EXTENSION_INTEGRATION_NOT_FOUND",
        "The requested extension integration is not in the reviewed adapter catalog.",
      );
    }
    const root = resolveLocalTrustedRoot(params.rootUri);
    const extension = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
    const installedVersion = extensionVersion(extension);
    if (!extension || !installedVersion) {
      return {
        instanceId: this.#instanceId,
        integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
        extensionId: PYTHON_EXTENSION_ID,
        rootUri: root.uri.toString(true),
        installedVersion: null,
        status: "unavailable",
        reason: "notInstalled",
        activatedByRequest: false,
        environment: null,
        observedAt: new Date().toISOString(),
      };
    }
    if (!isPythonExtensionVersionSupported(installedVersion)) {
      throw new BridgeError(
        "EXTENSION_VERSION_UNSUPPORTED",
        "The installed Python extension version is outside the reviewed adapter range.",
      );
    }

    const wasActive = extension.isActive;
    const api = await loadPythonExtensionApi(wasActive);
    const activatedByRequest = !wasActive && extension.isActive;
    assertPythonEnvironmentApi(api);

    let activeEnvironmentPath;
    try {
      await api.ready;
      activeEnvironmentPath = api.environments.getActiveEnvironmentPath(root);
    } catch {
      throw new BridgeError(
        "EXTENSION_INTEGRATION_UNAVAILABLE",
        "The reviewed Python environment API is not currently available.",
      );
    }
    if (!activeEnvironmentPath?.path) {
      return unresolved(this.#instanceId, root, installedVersion, activatedByRequest);
    }

    let resolved: ResolvedEnvironment | undefined;
    try {
      resolved = await api.environments.resolveEnvironment(activeEnvironmentPath);
    } catch {
      throw new BridgeError(
        "EXTENSION_INTEGRATION_UNAVAILABLE",
        "The Python extension could not resolve its active environment.",
      );
    }
    if (!resolved) {
      return unresolved(this.#instanceId, root, installedVersion, activatedByRequest);
    }

    return {
      instanceId: this.#instanceId,
      integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
      extensionId: PYTHON_EXTENSION_ID,
      rootUri: root.uri.toString(true),
      installedVersion,
      status: "resolved",
      reason: null,
      activatedByRequest,
      environment: normalizeReviewedPythonEnvironment({
        interpreterPath: resolved.executable.uri?.fsPath,
        environmentType: resolved.environment?.type,
        environmentName: resolved.environment?.name,
        version: resolved.version
          ? {
              major: resolved.version.major,
              minor: resolved.version.minor,
              micro: resolved.version.micro,
              release: resolved.version.release,
            }
          : undefined,
        architecture: resolved.executable.bitness,
      }),
      observedAt: new Date().toISOString(),
    };
  }
}

async function loadPythonExtensionApi(wasActive: boolean): Promise<PythonExtension> {
  try {
    return await PythonExtension.api();
  } catch {
    throw new BridgeError(
      wasActive ? "EXTENSION_INTEGRATION_UNAVAILABLE" : "EXTENSION_ACTIVATION_FAILED",
      wasActive
        ? "The reviewed Python extension API facade is unavailable."
        : "The reviewed Python extension could not be activated.",
    );
  }
}

function assertPythonEnvironmentApi(api: PythonExtension | undefined): asserts api is PythonExtension {
  if (
    !api
    || !api.environments
    || typeof api.environments.getActiveEnvironmentPath !== "function"
    || typeof api.environments.resolveEnvironment !== "function"
  ) {
    throw new BridgeError(
      "EXTENSION_INTEGRATION_UNAVAILABLE",
      "The Python extension API does not match the reviewed facade contract.",
    );
  }
}

function resolveLocalTrustedRoot(rootUri: string): vscode.WorkspaceFolder {
  if (!vscode.workspace.isTrusted) {
    throw new BridgeError(
      "WORKSPACE_UNTRUSTED",
      "Extension integration state requires a trusted workspace.",
    );
  }
  if (vscode.env.remoteName) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote extension integrations are unsupported.");
  }
  const normalized = vscode.Uri.parse(rootUri, true).toString(true);
  const root = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === "file" && folder.uri.toString(true) === normalized,
  );
  if (!root) {
    throw new BridgeError(
      "RESOURCE_OUT_OF_SCOPE",
      "Select a local root from the current VS Code workspace.",
    );
  }
  return root;
}

function extensionVersion(extension: vscode.Extension<unknown> | undefined): string | undefined {
  const version = extension?.packageJSON?.version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

function unresolved(
  instanceId: string,
  root: vscode.WorkspaceFolder,
  installedVersion: string,
  activatedByRequest: boolean,
): ExtensionIntegrationStateResult {
  return {
    instanceId,
    integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
    extensionId: PYTHON_EXTENSION_ID,
    rootUri: root.uri.toString(true),
    installedVersion,
    status: "unresolved",
    reason: "noActiveEnvironment",
    activatedByRequest,
    environment: null,
    observedAt: new Date().toISOString(),
  };
}
