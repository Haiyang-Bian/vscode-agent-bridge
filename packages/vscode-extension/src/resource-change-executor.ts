import { createHash } from "node:crypto";
import path from "node:path";

import * as vscode from "vscode";

import {
  BridgeError,
  type ResourceChange,
} from "@vscode-agent-bridge/protocol";

const MAX_RESOURCE_SNAPSHOT_ENTRIES = 500;
const MAX_RESOURCE_SNAPSHOT_BYTES = 50 * 1024 * 1024;

interface ResourceSnapshotEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly content: Uint8Array | null;
  readonly sha256: string | null;
}

export interface ResourceSnapshot {
  readonly uri: vscode.Uri;
  readonly exists: boolean;
  readonly kind: "file" | "directory" | null;
  readonly digest: string | null;
  readonly entries: readonly ResourceSnapshotEntry[];
}

export interface PreparedResourceOperation {
  readonly operation: ResourceChange;
  readonly uri: vscode.Uri;
  readonly targetUri: vscode.Uri | null;
  readonly before: ResourceSnapshot;
  readonly targetBefore: ResourceSnapshot | null;
}

export interface PreparedResourcePlan {
  readonly root: vscode.Uri;
  readonly operations: readonly PreparedResourceOperation[];
  readonly affectedUris: readonly vscode.Uri[];
}

export async function prepareResourcePlan(
  rootUri: string,
  operations: readonly ResourceChange[],
): Promise<PreparedResourcePlan> {
  const root = vscode.Uri.parse(rootUri, true);
  if (root.scheme !== "file") {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Resource changes require a local file workspace.");
  }
  const resolved = operations.map((operation) => ({
    operation,
    uri: parseResourceUri(operation.uri, root),
    targetUri:
      operation.operation === "rename" ? parseResourceUri(operation.targetUri, root) : null,
  }));
  assertNonOverlappingResourcePaths(
    resolved.flatMap(({ uri, targetUri }) => (targetUri ? [uri, targetUri] : [uri])),
  );

  const prepared: PreparedResourceOperation[] = [];
  for (const item of resolved) {
    const before = await snapshotResource(item.uri);
    const targetBefore = item.targetUri ? await snapshotResource(item.targetUri) : null;
    validateRequestedPreconditions(item.operation, before, targetBefore);
    prepared.push({ ...item, before, targetBefore });
  }
  return {
    root,
    operations: prepared,
    affectedUris: uniqueUris(
      prepared.flatMap(({ before, targetBefore, targetUri }) => [
        ...snapshotUris(before),
        ...(targetBefore ? snapshotUris(targetBefore) : []),
        ...(targetUri
          ? before.entries
              .filter((entry) => entry.relativePath.length > 0)
              .map((entry) => joinUri(targetUri, entry.relativePath))
          : []),
      ]),
    ),
  };
}

export async function assertResourcePlanFresh(plan: PreparedResourcePlan): Promise<void> {
  for (const prepared of plan.operations) {
    const current = await snapshotResource(prepared.uri);
    if (!sameSnapshot(current, prepared.before)) {
      throw new BridgeError(
        "STALE_CHANGE_SET",
        "A resource changed after the resource Change Set was prepared.",
      );
    }
    if (prepared.targetUri && prepared.targetBefore) {
      const target = await snapshotResource(prepared.targetUri);
      if (!sameSnapshot(target, prepared.targetBefore)) {
        throw new BridgeError(
          "STALE_CHANGE_SET",
          "A resource target changed after the resource Change Set was prepared.",
        );
      }
    }
  }
}

export async function applyResourcePlan(plan: PreparedResourcePlan): Promise<void> {
  const applied: PreparedResourceOperation[] = [];
  try {
    for (const prepared of plan.operations) {
      await applyOperation(prepared);
      applied.push(prepared);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const prepared of applied.reverse()) {
      try {
        await restoreSnapshot(prepared.targetBefore);
        await restoreSnapshot(prepared.before);
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      throw new BridgeError(
        "RESOURCE_RECOVERY_REQUIRED",
        "A resource operation failed and its safety snapshot could not be fully restored.",
      );
    }
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "VS Code could not apply the resource Change Set.");
  }
}

async function applyOperation(prepared: PreparedResourceOperation): Promise<void> {
  const operation = prepared.operation;
  if (operation.operation === "create") {
    if (operation.kind === "directory") {
      await vscode.workspace.fs.createDirectory(prepared.uri);
    } else {
      await vscode.workspace.fs.createDirectory(parentUri(prepared.uri));
      await vscode.workspace.fs.writeFile(prepared.uri, Buffer.from(operation.content!, "utf8"));
    }
    return;
  }
  if (operation.operation === "rename") {
    await vscode.workspace.fs.rename(prepared.uri, prepared.targetUri!, { overwrite: false });
    return;
  }
  await vscode.workspace.fs.delete(prepared.uri, {
    recursive: operation.kind === "directory" && operation.recursive,
    useTrash: false,
  });
}

async function restoreSnapshot(snapshot: ResourceSnapshot | null): Promise<void> {
  if (!snapshot) {
    return;
  }
  const current = await snapshotResource(snapshot.uri, false);
  if (!snapshot.exists) {
    if (current.exists) {
      await vscode.workspace.fs.delete(snapshot.uri, { recursive: true, useTrash: false });
    }
    return;
  }
  if (current.exists) {
    await vscode.workspace.fs.delete(snapshot.uri, { recursive: true, useTrash: false });
  }
  if (snapshot.kind === "file") {
    await vscode.workspace.fs.createDirectory(parentUri(snapshot.uri));
    await vscode.workspace.fs.writeFile(snapshot.uri, snapshot.entries[0]!.content!);
    return;
  }
  await vscode.workspace.fs.createDirectory(snapshot.uri);
  for (const entry of snapshot.entries) {
    const uri = joinUri(snapshot.uri, entry.relativePath);
    if (entry.kind === "directory") {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      await vscode.workspace.fs.createDirectory(parentUri(uri));
      await vscode.workspace.fs.writeFile(uri, entry.content!);
    }
  }
}

async function snapshotResource(
  uri: vscode.Uri,
  enforceRecoverable = true,
): Promise<ResourceSnapshot> {
  let rootStat: vscode.FileStat;
  try {
    rootStat = await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if (isFileNotFound(error)) {
      return { uri, exists: false, kind: null, digest: null, entries: [] };
    }
    throw error;
  }
  assertPlainResource(uri, rootStat);
  const kind = isDirectory(rootStat) ? "directory" : "file";
  const entries: ResourceSnapshotEntry[] = [];
  let totalBytes = 0;

  const visit = async (current: vscode.Uri, relativePath: string): Promise<void> => {
    if (entries.length >= MAX_RESOURCE_SNAPSHOT_ENTRIES) {
      throw new BridgeError("EDIT_LIMIT_EXCEEDED", "A recursive resource snapshot contains too many entries.");
    }
    const resourceStat = await vscode.workspace.fs.stat(current);
    assertPlainResource(current, resourceStat);
    if (isDirectory(resourceStat)) {
      if (relativePath) {
        entries.push({ relativePath, kind: "directory", content: null, sha256: null });
      }
      const children = await vscode.workspace.fs.readDirectory(current);
      for (const [name] of children.sort(([left], [right]) => left.localeCompare(right))) {
        await visit(vscode.Uri.joinPath(current, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    const content = await vscode.workspace.fs.readFile(current);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_RESOURCE_SNAPSHOT_BYTES) {
      throw new BridgeError("EDIT_LIMIT_EXCEEDED", "A recursive resource snapshot exceeds the byte limit.");
    }
    if (content.includes(0) && enforceRecoverable) {
      throw new BridgeError("RESOURCE_TYPE_UNSUPPORTED", "Binary resources are outside recoverable resource changes.");
    }
    entries.push({
      relativePath,
      kind: "file",
      content,
      sha256: sha256Bytes(content),
    });
  };
  await visit(uri, "");
  const digest = kind === "file"
    ? entries[0]!.sha256
    : createHash("sha256")
        .update(
          entries
            .map((entry) => `${entry.kind}:${entry.relativePath}:${entry.sha256 ?? ""}`)
            .join("\n"),
        )
        .digest("hex");
  return { uri, exists: true, kind, digest, entries };
}

function validateRequestedPreconditions(
  operation: ResourceChange,
  before: ResourceSnapshot,
  targetBefore: ResourceSnapshot | null,
): void {
  if (operation.operation === "create") {
    if (before.exists) {
      throw new BridgeError("RESOURCE_ALREADY_EXISTS", "The resource creation target already exists.");
    }
    return;
  }
  if (!before.exists) {
    throw new BridgeError("RESOURCE_NOT_FOUND", "The requested resource does not exist.");
  }
  if (before.kind !== operation.kind) {
    throw new BridgeError("RESOURCE_TYPE_UNSUPPORTED", "The requested resource kind does not match the target.");
  }
  if (operation.kind === "file" && before.digest !== operation.expectedSha256) {
    throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "The resource content hash precondition failed.");
  }
  if (operation.kind === "directory" && operation.expectedSha256 !== null) {
    throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "Directory resource changes require a null content hash.");
  }
  if (operation.operation === "rename" && targetBefore?.exists) {
    throw new BridgeError("RESOURCE_ALREADY_EXISTS", "The resource rename target already exists.");
  }
  if (operation.operation === "delete" && operation.kind === "directory" && !operation.recursive && before.entries.length > 0) {
    throw new BridgeError("RESOURCE_PRECONDITION_FAILED", "Deleting a non-empty directory requires recursive=true.");
  }
}

function parseResourceUri(rawUri: string, root: vscode.Uri): vscode.Uri {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(rawUri, true);
  } catch {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The resource URI is invalid.");
  }
  if (uri.scheme !== "file") {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Resource changes support only local file URIs.");
  }
  const relative = path.relative(path.resolve(root.fsPath), path.resolve(uri.fsPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The resource must be below the active experiment root.");
  }
  if (relative.split(path.sep).some((segment) => segment.toLowerCase() === ".git")) {
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Git metadata is outside the resource change surface.");
  }
  return vscode.Uri.file(path.resolve(uri.fsPath));
}

function assertNonOverlappingResourcePaths(uris: readonly vscode.Uri[]): void {
  const normalized = uris.map((uri) => normalizeFsPath(uri.fsPath)).sort();
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current === previous || current.startsWith(`${previous}${path.sep}`)) {
      throw new BridgeError("EDIT_OUT_OF_SCOPE", "Resource Change Set paths cannot overlap.");
    }
  }
}

function assertPlainResource(uri: vscode.Uri, resourceStat: vscode.FileStat): void {
  if ((resourceStat.type & vscode.FileType.SymbolicLink) !== 0) {
    throw new BridgeError("RESOURCE_TYPE_UNSUPPORTED", `Symbolic resources are not supported: ${path.basename(uri.fsPath)}`);
  }
  if (!isDirectory(resourceStat) && (resourceStat.type & vscode.FileType.File) === 0) {
    throw new BridgeError("RESOURCE_TYPE_UNSUPPORTED", "The resource type is not recoverable.");
  }
}

function isDirectory(resourceStat: vscode.FileStat): boolean {
  return (resourceStat.type & vscode.FileType.Directory) !== 0;
}

function sameSnapshot(left: ResourceSnapshot, right: ResourceSnapshot): boolean {
  return left.exists === right.exists && left.kind === right.kind && left.digest === right.digest;
}

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(path.dirname(uri.fsPath));
}

function joinUri(root: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.file(path.join(root.fsPath, ...relativePath.split("/")));
}

function uniqueUris(uris: readonly vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(true), uri])).values()];
}

function snapshotUris(snapshot: ResourceSnapshot): vscode.Uri[] {
  return uniqueUris([
    snapshot.uri,
    ...snapshot.entries
      .filter((entry) => entry.relativePath.length > 0)
      .map((entry) => joinUri(snapshot.uri, entry.relativePath)),
  ]);
}

function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}
