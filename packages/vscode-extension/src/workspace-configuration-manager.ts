import { createHash, randomUUID } from "node:crypto";

import * as vscode from "vscode";
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

import {
  BridgeError,
  type BridgeExecutionMode,
  type GetWorkspaceConfigurationParams,
  type UpdateWorkspaceConfigurationParams,
  type UpdateWorkspaceConfigurationResult,
  type WorkspaceConfigurationResult,
  type WorkspaceConfigurationTarget,
} from "@vscode-agent-bridge/protocol";

import { ExperimentManager } from "./experiment-manager.js";

const MAX_CONFIGURATION_CONTENT_CHARACTERS = 900_000;

export class WorkspaceConfigurationManager {
  readonly #instanceId: string;
  readonly #experiments: ExperimentManager;

  constructor(instanceId: string, experiments: ExperimentManager) {
    this.#instanceId = instanceId;
    this.#experiments = experiments;
  }

  async getConfiguration(
    params: GetWorkspaceConfigurationParams,
  ): Promise<WorkspaceConfigurationResult> {
    const target = resolveConfigurationTarget(params.rootUri, params.target);
    const loaded = await readConfiguration(target.uri);
    const content = loaded.content.slice(0, MAX_CONFIGURATION_CONTENT_CHARACTERS);
    return {
      instanceId: this.#instanceId,
      rootUri: params.rootUri,
      target: params.target,
      uri: target.uri?.toString(true) ?? null,
      exists: loaded.exists,
      content,
      contentSha256: loaded.exists ? sha256(loaded.content) : null,
      parseErrors: parseDiagnostics(loaded.content),
      deferredEffects: loaded.exists && detectsDeferredExecution(loaded.content, params.target),
      returnedCharacters: content.length,
      totalCharacters: loaded.content.length,
      truncated: content.length < loaded.content.length,
    };
  }

  async updateConfiguration(
    params: UpdateWorkspaceConfigurationParams,
  ): Promise<UpdateWorkspaceConfigurationResult> {
    const experiment = await this.#experiments.assertResourceChangesAllowed(params.sessionId);
    if (experiment.rootUri !== params.rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The configuration target is outside the active experiment root.");
    }
    const target = resolveConfigurationTarget(params.rootUri, params.target);
    if (!target.uri) {
      throw new BridgeError(
        "WORKSPACE_CONFIGURATION_TARGET_DENIED",
        "A .code-workspace file can be changed only when the current workspace already has one.",
      );
    }
    const loaded = await readConfiguration(target.uri);
    if (loaded.exists !== params.expectedExists) {
      throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "The configuration existence precondition failed.");
    }
    if (loaded.exists && sha256(loaded.content) !== params.expectedSha256) {
      throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "The configuration content hash precondition failed.");
    }
    if (!loaded.exists && params.expectedSha256 !== null) {
      throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "A missing configuration cannot have an expected hash.");
    }
    if (loaded.exists && parseDiagnostics(loaded.content).length > 0) {
      await revealInvalidConfiguration(target.uri);
      throw new BridgeError(
        "WORKSPACE_CONFIGURATION_INVALID",
        "The configuration contains JSONC parse errors and was opened without being overwritten.",
      );
    }

    let content = loaded.exists ? loaded.content : "{}\n";
    for (const operation of params.operations) {
      const path = parseJsonPointer(operation.path);
      if (
        params.target === "workspace" &&
        (path[0] === "folders" || path[0] === "remoteAuthority")
      ) {
        throw new BridgeError(
          "WORKSPACE_CONFIGURATION_TARGET_DENIED",
          ".code-workspace folders and remote authority are outside the bridge configuration surface.",
        );
      }
      const tree = parseTree(content);
      const existing = tree ? findNodeAtLocation(tree, path) : undefined;
      if ((operation.operation === "replace" || operation.operation === "remove") && !existing) {
        throw new BridgeError(
          "WORKSPACE_CONFIGURATION_INVALID",
          "A JSON Pointer replace/remove target does not exist.",
        );
      }
      content = applyEdits(
        content,
        modify(
          content,
          path,
          operation.operation === "remove" ? undefined : operation.value,
          { formattingOptions: detectFormatting(content) },
        ),
      );
    }
    const policy = validateConfigurationContent(target.uri, content, params.target);
    await this.#experiments.captureBeforeResourceApply(params.sessionId, [target.uri]);
    try {
      await writeConfigurationAtomic(target.uri, content);
    } catch {
      await this.#experiments.markResourceRecoveryRequired(params.sessionId);
      throw new BridgeError(
        "RESOURCE_RECOVERY_REQUIRED",
        "The configuration could not be atomically replaced; use the safety checkpoint for recovery.",
      );
    }
    const checkpointId = await this.#experiments.captureAfterAgentApply(
      params.sessionId,
      params.reason,
      [target.uri],
    );
    return {
      instanceId: this.#instanceId,
      sessionId: params.sessionId,
      rootUri: params.rootUri,
      target: params.target,
      uri: target.uri.toString(true),
      created: !loaded.exists,
      saved: true,
      contentSha256: sha256(content),
      checkpointId,
      deferredEffects: policy.deferredEffects,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function validateConfigurationContentForUri(
  uri: vscode.Uri,
  content: string,
  beforeContent?: string,
): { readonly deferredEffects: boolean } {
  const target = configurationKindForUri(uri);
  if (target === "workspace" && beforeContent !== undefined) {
    const before = parse(beforeContent) as unknown;
    const after = parse(content) as unknown;
    if (
      !isRecord(before) ||
      !isRecord(after) ||
      JSON.stringify(before.folders) !== JSON.stringify(after.folders) ||
      JSON.stringify(before.remoteAuthority) !== JSON.stringify(after.remoteAuthority)
    ) {
      throw new BridgeError(
        "WORKSPACE_CONFIGURATION_TARGET_DENIED",
        ".code-workspace folders and remote authority cannot be changed by Agent text edits.",
      );
    }
  }
  return target ? validateConfigurationContent(uri, content, target, beforeContent !== undefined) : { deferredEffects: false };
}

export function validateConfigurationContent(
  uri: vscode.Uri,
  content: string,
  target: WorkspaceConfigurationTarget,
  allowExistingWorkspaceBoundary = true,
): { readonly deferredEffects: boolean } {
  const errors = parseDiagnostics(content);
  if (errors.length > 0) {
    throw new BridgeError("WORKSPACE_CONFIGURATION_INVALID", "An Agent edit would leave workspace JSONC invalid.");
  }
  const parsed = parse(content) as unknown;
  if (target === "workspace" && !allowExistingWorkspaceBoundary && isRecord(parsed)) {
    if (Object.hasOwn(parsed, "folders") || Object.hasOwn(parsed, "remoteAuthority")) {
      throw new BridgeError(
        "WORKSPACE_CONFIGURATION_TARGET_DENIED",
        ".code-workspace folders and remote authority are outside the bridge configuration surface.",
      );
    }
  }
  const deferredEffects = detectsDeferredExecutionValue(parsed, target);
  if (deferredEffects && getExecutionMode() === "explicit") {
    throw new BridgeError(
      "DEFERRED_EXECUTION_DENIED",
      "Explicit execution mode rejects configuration that can run tasks after the Agent request ends.",
    );
  }
  return { deferredEffects };
}

export function configurationKindForUri(
  uri: vscode.Uri,
): WorkspaceConfigurationTarget | null {
  if (uri.scheme !== "file") {
    return null;
  }
  const normalized = uri.path.toLowerCase();
  if (normalized.endsWith("/.vscode/settings.json")) return "settings";
  if (normalized.endsWith("/.vscode/launch.json")) return "launch";
  if (normalized.endsWith("/.vscode/tasks.json")) return "tasks";
  if (normalized.endsWith(".code-workspace")) return "workspace";
  return null;
}

function resolveConfigurationTarget(
  rootUri: string,
  target: WorkspaceConfigurationTarget,
): { readonly root: vscode.WorkspaceFolder; readonly uri: vscode.Uri | null } {
  const root = (vscode.workspace.workspaceFolders ?? []).find(
    (folder) => folder.uri.toString(true) === rootUri,
  );
  if (!root || root.uri.scheme !== "file") {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The configuration root is not a local workspace folder.");
  }
  const uri =
    target === "workspace"
      ? vscode.workspace.workspaceFile?.scheme === "file"
        ? vscode.workspace.workspaceFile
        : null
      : vscode.Uri.joinPath(root.uri, ".vscode", `${target}.json`);
  return { root, uri };
}

async function readConfiguration(
  uri: vscode.Uri | null,
): Promise<{ readonly exists: boolean; readonly content: string }> {
  if (!uri) {
    return { exists: false, content: "" };
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) {
      throw new BridgeError("WORKSPACE_CONFIGURATION_INVALID", "Workspace configuration must be UTF-8 text.");
    }
    return { exists: true, content: Buffer.from(bytes).toString("utf8") };
  } catch (error) {
    if (isFileNotFound(error)) {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

async function writeConfigurationAtomic(uri: vscode.Uri, content: string): Promise<void> {
  const temporary = uri.with({ path: `${uri.path}.${process.pid}.${randomUUID()}.tmp` });
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
  try {
    await vscode.workspace.fs.writeFile(temporary, Buffer.from(content, "utf8"));
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } finally {
    try {
      await vscode.workspace.fs.delete(temporary, { useTrash: false });
    } catch {
      // The normal atomic rename consumes the temporary file.
    }
  }
}

function parseDiagnostics(content: string): string[] {
  if (!content.trim()) {
    return [];
  }
  const errors: ParseError[] = [];
  parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.slice(0, 100).map(
    (error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`.slice(0, 500),
  );
}

function parseJsonPointer(pointer: string): (string | number)[] {
  if (pointer === "") {
    return [];
  }
  return pointer.slice(1).split("/").map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return /^(0|[1-9]\d*)$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function detectsDeferredExecution(content: string, target: WorkspaceConfigurationTarget): boolean {
  if (parseDiagnostics(content).length > 0) {
    return false;
  }
  return detectsDeferredExecutionValue(parse(content), target);
}

function detectsDeferredExecutionValue(value: unknown, target: WorkspaceConfigurationTarget): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const settings = target === "workspace" && isRecord(value.settings) ? value.settings : value;
  const automaticTasks = isRecord(settings) ? settings["task.allowAutomaticTasks"] : undefined;
  if (automaticTasks === true || automaticTasks === "on") {
    return true;
  }
  const taskContainer = target === "workspace" ? value.tasks : value;
  const tasks = isRecord(taskContainer) && Array.isArray(taskContainer.tasks)
    ? taskContainer.tasks
    : Array.isArray(taskContainer)
      ? taskContainer
      : [];
  return tasks.some(
    (task) =>
      isRecord(task) &&
      isRecord(task.runOptions) &&
      task.runOptions.runOn === "folderOpen",
  );
}

function detectFormatting(content: string) {
  const line = content.split(/\r?\n/).find((candidate) => /^\s+\S/.test(candidate));
  const indentation = line?.match(/^\s+/)?.[0] ?? "  ";
  return {
    insertSpaces: !indentation.includes("\t"),
    tabSize: indentation.includes("\t") ? 1 : Math.max(1, indentation.length),
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

function getExecutionMode(): BridgeExecutionMode {
  return vscode.workspace
    .getConfiguration("vscodeAgentBridge")
    .get<BridgeExecutionMode>("executionMode", "explicit");
}

async function revealInvalidConfiguration(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    // The stable error remains the configuration parse failure.
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
