import path from "node:path";

import * as vscode from "vscode";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { CanonicalPathBoundary } from "./canonical-path-boundary.js";
import { DocumentAccessGrantStore } from "./document-access-grants.js";

export interface AuthorizedDocument {
  readonly uri: vscode.Uri;
  readonly sourceWorkspaceUri: string;
}

export interface ProviderDocumentGrant {
  readonly accessGrantId: string | null;
  readonly accessGrantExpiresAt: string | null;
}

export class DocumentAccessController {
  readonly #grants: DocumentAccessGrantStore;

  constructor(instanceId: string) {
    this.#grants = new DocumentAccessGrantStore(instanceId);
  }

  async authorize(rawUri: string, accessGrantId?: string): Promise<AuthorizedDocument> {
    const uri = parseUri(rawUri);
    const normalized = uri.toString(true);
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString(true) === normalized);
    if (open) {
      return { uri, sourceWorkspaceUri: sourceWorkspaceUri(uri) };
    }
    if (uri.scheme === "file") {
      const roots = localWorkspaceRoots();
      if (roots.length > 0) {
        try {
          const checked = await new CanonicalPathBoundary(roots.map((root) => root.uri.fsPath)).assertPath(uri.fsPath);
          const root = roots.find((candidate) => sameFsPath(candidate.uri.fsPath, checked.rootPath));
          if (root) return { uri: vscode.Uri.file(checked.canonicalPath), sourceWorkspaceUri: root.uri.toString(true) };
        } catch (error) {
          if (!(error instanceof BridgeError) || (error.code !== "RESOURCE_OUT_OF_SCOPE" && error.code !== "RESOURCE_NOT_FOUND")) throw error;
        }
      }
    }
    if (accessGrantId) {
      const grant = this.#grants.authorize(accessGrantId, normalized);
      return { uri, sourceWorkspaceUri: grant.sourceWorkspaceUri };
    }
    throw new BridgeError(
      "DOCUMENT_ACCESS_DENIED",
      "The document must already be open, resolve canonically inside a trusted workspace root, or carry an exact provider-derived grant.",
    );
  }

  async grantProviderResult(rawUri: string, sourceWorkspaceUri: string): Promise<ProviderDocumentGrant> {
    const uri = parseUri(rawUri);
    const normalized = uri.toString(true);
    const open = vscode.workspace.textDocuments.some((document) => document.uri.toString(true) === normalized);
    if (open || await this.#isWorkspaceFile(uri)) {
      return { accessGrantId: null, accessGrantExpiresAt: null };
    }
    const grant = this.#grants.issue(normalized, sourceWorkspaceUri);
    return { accessGrantId: grant.accessGrantId, accessGrantExpiresAt: grant.expiresAt };
  }

  async #isWorkspaceFile(uri: vscode.Uri): Promise<boolean> {
    if (uri.scheme !== "file") return false;
    const roots = localWorkspaceRoots();
    if (roots.length === 0) return false;
    try {
      await new CanonicalPathBoundary(roots.map((root) => root.uri.fsPath)).assertPath(uri.fsPath);
      return true;
    } catch (error) {
      if (error instanceof BridgeError && (error.code === "RESOURCE_OUT_OF_SCOPE" || error.code === "RESOURCE_NOT_FOUND")) return false;
      throw error;
    }
  }
}

function parseUri(rawUri: string): vscode.Uri {
  try {
    const uri = vscode.Uri.parse(rawUri, true);
    if (!uri.scheme) throw new Error("missing scheme");
    return uri;
  } catch {
    throw new BridgeError("DOCUMENT_NOT_FOUND", "The requested document URI is invalid.");
  }
}

function sourceWorkspaceUri(uri: vscode.Uri): string {
  const direct = vscode.workspace.getWorkspaceFolder(uri);
  const fallback = vscode.workspace.workspaceFolders?.[0];
  if (!direct && !fallback) {
    throw new BridgeError("DOCUMENT_ACCESS_DENIED", "Provider-derived access requires a source workspace root.");
  }
  return (direct ?? fallback)!.uri.toString(true);
}

function localWorkspaceRoots(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((root) => root.uri.scheme === "file");
}

function sameFsPath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
