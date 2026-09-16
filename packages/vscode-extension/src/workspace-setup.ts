import * as vscode from "vscode";

import {
  BridgeError,
  WorkspaceSetupResultSchema,
  type GetWorkspaceSetupParams,
  type WorkspaceSetupResult,
} from "@vscode-agent-bridge/protocol";

export class WorkspaceSetupService {
  readonly #instanceId: string;

  constructor(instanceId: string) {
    this.#instanceId = instanceId;
  }

  async getSetup(params: GetWorkspaceSetupParams): Promise<WorkspaceSetupResult> {
    const root = this.resolveRoot(params.rootUri);
    const vscodeDirectory = vscode.Uri.joinPath(root.uri, ".vscode");
    const workspaceFile = vscode.workspace.workspaceFile;
    return WorkspaceSetupResultSchema.parse({
      instanceId: this.#instanceId,
      rootUri: root.uri.toString(true),
      workspaceKind: workspaceFile ? "workspaceFile" : "folder",
      trusted: vscode.workspace.isTrusted,
      remoteName: vscode.env.remoteName ?? null,
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
    if (rootUri) return resolveWorkspaceRoot(rootUri);
    if (folders.length !== 1) {
      throw new BridgeError(
        "INVALID_REQUEST",
        "rootUri is required unless the VS Code window contains exactly one workspace root.",
      );
    }
    return assertLocalRoot(folders[0]!);
  }
}

export function resolveWorkspaceRoot(rootUri: string): vscode.WorkspaceFolder {
  let normalized: string;
  try {
    normalized = vscode.Uri.parse(rootUri, true).toString(true);
  } catch {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The requested workspace root URI is invalid.");
  }
  const selected = (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.toString(true) === normalized,
  );
  if (!selected) {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Select a root URI from the current VS Code workspace.");
  }
  return assertLocalRoot(selected);
}

export function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BridgeError("REQUEST_CANCELLED", "The Agent request was cancelled before the operation completed.");
  }
}

export function assertWorkspaceMutationAllowed(root: vscode.WorkspaceFolder): void {
  if (vscode.env.remoteName) {
    throw new BridgeError("UNSUPPORTED_REMOTE", "Remote workspace mutation is unsupported.");
  }
  if (!vscode.workspace.isTrusted) {
    throw new BridgeError("WORKSPACE_UNTRUSTED", "Trust the workspace before allowing Agent mutations.");
  }
  assertLocalRoot(root);
}

function assertLocalRoot(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
  if (folder.uri.scheme !== "file") {
    throw new BridgeError("UNSUPPORTED_REMOTE", "The Bridge requires a local file workspace root.");
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
    return error instanceof vscode.FileSystemError && error.code === "FileNotFound"
      ? "missing"
      : "unreadable";
  }
}
