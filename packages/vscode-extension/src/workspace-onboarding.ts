import * as vscode from "vscode";

import {
  AgentEditVisibilitySchema,
  BridgeError,
  WorkspaceSetupResultSchema,
  type AgentEditVisibility,
  type GetWorkspaceSetupParams,
  type WorkspaceSetupResult,
} from "@vscode-agent-bridge/protocol";

import { assertAgentWriteAllowed } from "./policies.js";

const CONFIGURATION_SECTION = "vscodeAgentBridge";
const ENABLED_SETTING = "experiments.enabled";
const VISIBILITY_SETTING = "agentEditVisibility";

type OnboardingSource = "agent" | "user";

export class WorkspaceOnboardingService {
  readonly #instanceId: string;
  readonly #declinedRoots = new Set<string>();

  constructor(instanceId: string) {
    this.#instanceId = instanceId;
  }

  async getSetup(params: GetWorkspaceSetupParams): Promise<WorkspaceSetupResult> {
    const root = this.resolveRoot(params.rootUri);
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, root.uri);
    const folderValue = configuration.inspect<boolean>(ENABLED_SETTING)?.workspaceFolderValue;
    const onboarding =
      folderValue === undefined ? "unconfigured" : folderValue ? "enabled" : "disabled";
    const vscodeDirectory = vscode.Uri.joinPath(root.uri, ".vscode");
    const workspaceFile = vscode.workspace.workspaceFile;

    return WorkspaceSetupResultSchema.parse({
      instanceId: this.#instanceId,
      rootUri: root.uri.toString(true),
      workspaceKind: workspaceFile ? "workspaceFile" : "folder",
      trusted: vscode.workspace.isTrusted,
      remoteName: vscode.env.remoteName ?? null,
      onboarding,
      editVisibility: this.getEditVisibility(root.uri),
      vscodeDirectory: await inspectUri(vscodeDirectory, "directory"),
      files: [
        await inspectSetupFile("settings", vscode.Uri.joinPath(vscodeDirectory, "settings.json")),
        await inspectSetupFile("launch", vscode.Uri.joinPath(vscodeDirectory, "launch.json")),
        await inspectSetupFile("tasks", vscode.Uri.joinPath(vscodeDirectory, "tasks.json")),
        workspaceFile
          ? await inspectSetupFile("workspace", workspaceFile, true)
          : { kind: "workspace", state: "missing", uri: null },
      ],
    });
  }

  resolveRoot(rootUri?: string): vscode.WorkspaceFolder {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (rootUri) {
      const normalized = vscode.Uri.parse(rootUri, true).toString(true);
      const selected = folders.find((folder) => folder.uri.toString(true) === normalized);
      if (!selected) {
        throw new BridgeError(
          "INVALID_REQUEST",
          "Select a root URI from the current VS Code workspace.",
        );
      }
      return selected;
    }
    if (folders.length !== 1) {
      throw new BridgeError(
        "INVALID_REQUEST",
        "rootUri is required unless the VS Code window contains exactly one workspace root.",
      );
    }
    return folders[0]!;
  }

  getEditVisibility(root: vscode.Uri): AgentEditVisibility {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, root)
      .get<unknown>(VISIBILITY_SETTING, "focusFirst");
    return AgentEditVisibilitySchema.catch("focusFirst").parse(value);
  }

  async ensureEnabled(
    root: vscode.WorkspaceFolder,
    proposedTitle: string,
    source: OnboardingSource,
  ): Promise<boolean> {
    assertAgentWriteAllowed();
    assertLocalRoot(root);
    const setup = await this.getSetup({ rootUri: root.uri.toString(true) });
    if (setup.onboarding === "enabled") {
      return false;
    }
    if (setup.onboarding === "disabled") {
      if (source === "agent") {
        throw new BridgeError(
          "POLICY_DENIED",
          "Agent experiments are explicitly disabled for this workspace root.",
        );
      }
      const choice = await vscode.window.showWarningMessage(
        "Agent experiments are disabled for this workspace root.",
        { modal: true },
        "Enable Experiments",
      );
      if (choice !== "Enable Experiments") {
        throw new BridgeError("WORKSPACE_ONBOARDING_DECLINED", "Workspace onboarding was declined.");
      }
      await this.#writeSettings(root, "focusFirst");
      return true;
    }

    const rootKey = root.uri.toString(true);
    if (source === "agent" && this.#declinedRoots.has(rootKey)) {
      throw new BridgeError(
        "WORKSPACE_ONBOARDING_DECLINED",
        "Workspace onboarding was declined in this VS Code window.",
      );
    }

    while (true) {
      const titleSuffix = proposedTitle ? ` Proposed experiment: “${proposedTitle}”.` : "";
      const choice = await vscode.window.showInformationMessage(
        `VS Code Agent Bridge found an unconfigured workspace root.${titleSuffix} Creating the experiment adds only durable Bridge settings under .vscode/settings.json and starts a local recovery journal whose snapshots may contain source code.`,
        { modal: true },
        "Create Experiment",
        "Review Setup",
        "Not Now",
      );
      if (choice === "Review Setup") {
        await this.showSetupReview(root.uri);
        continue;
      }
      if (choice === "Create Experiment") {
        await this.#writeSettings(root, "focusFirst");
        this.#declinedRoots.delete(rootKey);
        return true;
      }
      if (source === "agent") {
        this.#declinedRoots.add(rootKey);
      }
      throw new BridgeError("WORKSPACE_ONBOARDING_DECLINED", "Workspace onboarding was declined.");
    }
  }

  async configureInteractively(): Promise<void> {
    assertAgentWriteAllowed();
    const root = await pickWorkspaceRoot();
    if (!root) {
      return;
    }
    const setup = await this.getSetup({ rootUri: root.uri.toString(true) });
    const action = await vscode.window.showQuickPick(
      [
        {
          label: "Enable Agent Experiments",
          description: "Allow bounded Agent experiment writes for this workspace root.",
          value: true,
        },
        {
          label: "Disable Agent Experiments",
          description: "Reject Agent writes without deleting existing experiment data.",
          value: false,
        },
        {
          label: "Review Workspace Setup",
          description: summarizeSetup(setup),
          value: "review" as const,
        },
      ],
      {
        title: `Configure workspace experiment (${root.name})`,
        placeHolder: `Current onboarding state: ${setup.onboarding}`,
      },
    );
    if (!action) {
      return;
    }
    if (action.value === "review") {
      await this.showSetupReview(root.uri);
      return;
    }
    if (!action.value) {
      await this.#updateEnabled(root, false);
      await vscode.window.showInformationMessage(
        "Agent experiments disabled for this workspace root. Existing sessions were preserved.",
      );
      return;
    }

    const visibility = await vscode.window.showQuickPick(
      [
        { label: "Focus first and open all (Default)", value: "focusFirst" as const },
        { label: "Focus every target", value: "focusEach" as const },
        { label: "Open only the first target", value: "firstOnly" as const },
        { label: "Do not open target editors", value: "off" as const },
      ],
      {
        title: "Agent edit visibility",
        placeHolder: `Current: ${setup.editVisibility}`,
      },
    );
    if (!visibility) {
      return;
    }
    await this.#writeSettings(root, visibility.value);
    this.#declinedRoots.delete(root.uri.toString(true));
    await vscode.window.showInformationMessage("Workspace experiment settings updated.");
  }

  async showSetupReview(rootUri: vscode.Uri): Promise<void> {
    const setup = await this.getSetup({ rootUri: rootUri.toString(true) });
    await vscode.window.showInformationMessage(
      `Workspace setup: onboarding=${setup.onboarding}; .vscode=${setup.vscodeDirectory}; ${setup.files.map((file) => `${file.kind}=${file.state}`).join("; ")}. No configuration contents were read.`,
      { modal: true },
      "OK",
    );
  }

  async #writeSettings(
    root: vscode.WorkspaceFolder,
    visibility: AgentEditVisibility,
  ): Promise<void> {
    try {
      const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, root.uri);
      await configuration.update(ENABLED_SETTING, true, vscode.ConfigurationTarget.WorkspaceFolder);
      if (configuration.inspect(VISIBILITY_SETTING)?.workspaceFolderValue === undefined) {
        await configuration.update(
          VISIBILITY_SETTING,
          visibility,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      }
    } catch (error) {
      await openSettingsIfPresent(root.uri);
      throw configurationError(error);
    }
  }

  async #updateEnabled(root: vscode.WorkspaceFolder, enabled: boolean): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration(CONFIGURATION_SECTION, root.uri)
        .update(ENABLED_SETTING, enabled, vscode.ConfigurationTarget.WorkspaceFolder);
    } catch (error) {
      await openSettingsIfPresent(root.uri);
      throw configurationError(error);
    }
  }
}

async function pickWorkspaceRoot(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new BridgeError("INVALID_REQUEST", "Open a local workspace folder first.");
  }
  if (folders.length === 1) {
    return assertLocalRoot(folders[0]!);
  }
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, folder })),
    { title: "Select one workspace root for the experiment" },
  );
  return selected ? assertLocalRoot(selected.folder) : undefined;
}

function assertLocalRoot(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
  if (folder.uri.scheme !== "file") {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Workspace experiments require a local file root.");
  }
  return folder;
}

async function inspectSetupFile(
  kind: "settings" | "launch" | "tasks" | "workspace",
  uri: vscode.Uri,
  knownPresent = false,
): Promise<{ kind: typeof kind; state: "missing" | "present" | "unreadable"; uri: string | null }> {
  return {
    kind,
    state: knownPresent ? "present" : await inspectUri(uri, "file"),
    uri: uri.toString(true),
  };
}

async function inspectUri(
  uri: vscode.Uri,
  expected: "file" | "directory",
): Promise<"missing" | "present" | "unreadable"> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    const required = expected === "directory" ? vscode.FileType.Directory : vscode.FileType.File;
    return (stat.type & required) !== 0 ? "present" : "unreadable";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "unreadable";
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

async function openSettingsIfPresent(root: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(root, ".vscode", "settings.json");
  if ((await inspectUri(uri, "file")) !== "present") {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    // Preserve the original configuration failure.
  }
}

function summarizeSetup(setup: WorkspaceSetupResult): string {
  return `.vscode ${setup.vscodeDirectory}; ${setup.files.map((file) => `${file.kind} ${file.state}`).join(", ")}`;
}

function configurationError(error: unknown): BridgeError {
  return new BridgeError(
    "WORKSPACE_CONFIGURATION_INVALID",
    error instanceof Error
      ? `Could not safely update workspace settings: ${error.message}`
      : "Could not safely update workspace settings.",
  );
}
