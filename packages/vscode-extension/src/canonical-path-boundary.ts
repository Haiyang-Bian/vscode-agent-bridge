import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { BridgeError } from "@vscode-agent-bridge/protocol";

export interface CanonicalPathResult {
  readonly path: string;
  readonly canonicalPath: string;
  readonly rootPath: string;
  readonly canonicalRootPath: string;
  readonly exists: boolean;
}

export class CanonicalPathBoundary {
  readonly #rootPaths: readonly string[];

  constructor(rootPaths: readonly string[]) {
    this.#rootPaths = rootPaths.map((value) => path.resolve(value));
  }

  async assertPath(candidatePath: string, allowMissing = false): Promise<CanonicalPathResult> {
    const candidate = path.resolve(candidatePath);
    for (const rootPath of this.#rootPaths) {
      if (!isContained(rootPath, candidate, true)) continue;
      const canonicalRootPath = await nativeRealpath(rootPath).catch(() => {
        throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The workspace root cannot be resolved canonically.");
      });
      const relative = path.relative(rootPath, candidate);
      const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
      let current = rootPath;
      let exists = true;
      for (const segment of segments) {
        current = path.join(current, segment);
        let stat;
        try {
          stat = await lstat(current);
        } catch (error) {
          if (isNotFound(error) && allowMissing) {
            exists = false;
            break;
          }
          if (isNotFound(error)) {
            throw new BridgeError("RESOURCE_NOT_FOUND", "The canonical path target does not exist.");
          }
          throw error;
        }
        if (stat.isSymbolicLink()) {
          throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Symbolic links, junctions, and reparse-point paths are outside the Agent boundary.");
        }
      }
      const canonicalPath = exists
        ? await nativeRealpath(candidate)
        : path.resolve(canonicalRootPath, ...segments);
      if (!isContained(canonicalRootPath, canonicalPath, true)) {
        throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The canonical path escapes the workspace root.");
      }
      return { path: candidate, canonicalPath, rootPath, canonicalRootPath, exists };
    }
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The path is outside the trusted workspace roots.");
  }

  async assertRelativePath(rootPath: string, relativePath: string, allowMissing = false): Promise<CanonicalPathResult> {
    if (path.isAbsolute(relativePath)) {
      throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The path must be relative to the workspace root.");
    }
    const root = path.resolve(rootPath);
    if (!this.#rootPaths.some((candidate) => samePath(candidate, root))) {
      throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The selected root is not part of this canonical boundary.");
    }
    return this.assertPath(path.resolve(root, relativePath), allowMissing);
  }

  assertPathSync(candidatePath: string, allowMissing = false): CanonicalPathResult {
    const candidate = path.resolve(candidatePath);
    for (const rootPath of this.#rootPaths) {
      if (!isContained(rootPath, candidate, true)) continue;
      let canonicalRootPath: string;
      try {
        canonicalRootPath = path.resolve(realpathSync.native(rootPath));
      } catch {
        throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The workspace root cannot be resolved canonically.");
      }
      const relative = path.relative(rootPath, candidate);
      const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
      let current = rootPath;
      let exists = true;
      for (const segment of segments) {
        current = path.join(current, segment);
        try {
          if (lstatSync(current).isSymbolicLink()) {
            throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "Symbolic links, junctions, and reparse-point paths are outside the Agent boundary.");
          }
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          if (isNotFound(error) && allowMissing) {
            exists = false;
            break;
          }
          if (isNotFound(error)) throw new BridgeError("RESOURCE_NOT_FOUND", "The canonical path target does not exist.");
          throw error;
        }
      }
      const canonicalPath = exists ? path.resolve(realpathSync.native(candidate)) : path.resolve(canonicalRootPath, ...segments);
      if (!isContained(canonicalRootPath, canonicalPath, true)) {
        throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The canonical path escapes the workspace root.");
      }
      return { path: candidate, canonicalPath, rootPath, canonicalRootPath, exists };
    }
    throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The path is outside the trusted workspace roots.");
  }
}

export function isContained(rootPath: string, candidatePath: string, allowRoot = false): boolean {
  const relative = path.relative(normalizePath(rootPath), normalizePath(candidatePath));
  return (allowRoot || relative.length > 0) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

async function nativeRealpath(value: string): Promise<string> {
  return path.resolve(await realpath(value));
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
