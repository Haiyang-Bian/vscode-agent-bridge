import * as vscode from "vscode";
import { parse } from "jsonc-parser/lib/esm/main.js";

import {
  BridgeError,
  type ApplyExtensionInstallParams,
  type ApplyExtensionInstallResult,
  type PrepareExtensionInstallParams,
  type PreparedExtensionInstall,
  type SearchExtensionsParams,
  type SearchExtensionsResult,
} from "@vscode-agent-bridge/protocol";

import { assertAgentWriteAllowed } from "./policies.js";
import {
  ExtensionMarketplaceService,
  type InstalledExtensionState,
  type NativeExtensionInstaller,
} from "./extension-marketplace-service.js";
import { MarketplaceClient } from "./marketplace-client.js";

const NATIVE_INSTALL_COMMAND = "workbench.extensions.installExtension";
const NATIVE_DETAILS_COMMAND = "workbench.extensions.action.showExtensionsWithIds";

export class ExtensionMarketplaceManager {
  readonly #service: ExtensionMarketplaceService;

  constructor(instanceId: string) {
    this.#service = new ExtensionMarketplaceService({
      instanceId,
      client: new MarketplaceClient({
        getProxyUrl: () => vscode.workspace.getConfiguration("http").get<string>("proxy") ?? null,
      }),
      installer: new VscodeNativeExtensionInstaller(),
      vscodeVersion: vscode.version,
      targetPlatform: process.platform === "win32" && process.arch === "x64" ? "win32-x64" : "undefined",
      getInstalled: listInstalledExtensions,
    });
  }

  async search(params: SearchExtensionsParams): Promise<SearchExtensionsResult> {
    const recommendations = params.rootUri
      ? await readWorkspaceRecommendations(resolveRoot(params.rootUri).uri)
      : new Set<string>();
    return this.#service.search(params.query, params.offset, params.limit, recommendations);
  }

  async prepare(params: PrepareExtensionInstallParams): Promise<PreparedExtensionInstall> {
    assertAgentWriteAllowed();
    resolveRoot(params.rootUri);
    return this.#service.prepare(params.rootUri, params.candidateId);
  }

  async apply(params: ApplyExtensionInstallParams): Promise<ApplyExtensionInstallResult> {
    assertAgentWriteAllowed();
    return this.#service.apply(params.planId);
  }
}

class VscodeNativeExtensionInstaller implements NativeExtensionInstaller {
  async install(extensionId: string, plannedVersion: string) {
    const commands = new Set(await vscode.commands.getCommands(true));
    if (!commands.has(NATIVE_INSTALL_COMMAND)) {
      await openExtensionDetails(commands, extensionId);
      return {
        status: "userActionRequired" as const,
        installedVersion: installedVersion(extensionId),
        usedNativeInstallCommand: false,
      };
    }
    try {
      await vscode.commands.executeCommand(NATIVE_INSTALL_COMMAND, extensionId, {
        enable: true,
        installPreReleaseVersion: false,
      });
    } catch {
      await openExtensionDetails(commands, extensionId);
      return {
        status: "pendingUserTrust" as const,
        installedVersion: installedVersion(extensionId),
        usedNativeInstallCommand: true,
      };
    }
    const version = await waitForInstalledVersion(extensionId, plannedVersion);
    return version === plannedVersion
      ? {
          status: "installed" as const,
          installedVersion: version,
          usedNativeInstallCommand: true,
        }
      : {
          status: "pendingReload" as const,
          installedVersion: version,
          usedNativeInstallCommand: true,
        };
  }
}

async function waitForInstalledVersion(extensionId: string, plannedVersion: string): Promise<string | null> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const current = installedVersion(extensionId);
    if (current === plannedVersion) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return installedVersion(extensionId);
}

function installedVersion(extensionId: string): string | null {
  const extension = vscode.extensions.getExtension(extensionId);
  const version = extension?.packageJSON && typeof extension.packageJSON === "object"
    ? (extension.packageJSON as Record<string, unknown>).version
    : undefined;
  return typeof version === "string" ? version.slice(0, 200) : null;
}

async function openExtensionDetails(commands: ReadonlySet<string>, extensionId: string): Promise<void> {
  if (!commands.has(NATIVE_DETAILS_COMMAND)) return;
  try {
    await vscode.commands.executeCommand(NATIVE_DETAILS_COMMAND, [extensionId]);
  } catch {
    // The install result already explains that the user must use native VS Code UI.
  }
}

function listInstalledExtensions(): InstalledExtensionState[] {
  return vscode.extensions.all.flatMap((extension) => {
    if (!validExtensionId(extension.id)) return [];
    const manifest = record(extension.packageJSON);
    const publisher = stringValue(manifest.publisher, extension.id.split(".")[0]!, 200);
    return [{
      extensionId: extension.id,
      version: stringValue(manifest.version, "unknown", 200),
      publisher,
      displayName: stringValue(manifest.displayName, stringValue(manifest.name, extension.id, 500), 500),
      builtIn: manifest.isBuiltin === true,
      dependencies: extensionIds(manifest.extensionDependencies),
      extensionPack: extensionIds(manifest.extensionPack),
    }];
  });
}

async function readWorkspaceRecommendations(root: vscode.Uri): Promise<Set<string>> {
  const uri = vscode.Uri.joinPath(root, ".vscode", "extensions.json");
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return new Set();
  }
  if (bytes.byteLength > 256 * 1024) return new Set();
  const parsed = parse(Buffer.from(bytes).toString("utf8"), undefined, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  const recommendations = record(parsed).recommendations;
  return new Set(
    (Array.isArray(recommendations) ? recommendations : [])
      .filter((value): value is string => typeof value === "string" && validExtensionId(value))
      .slice(0, 500)
      .map((value) => value.toLowerCase()),
  );
}

function resolveRoot(rootUri: string): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.uri.toString(true) === rootUri && candidate.uri.scheme === "file",
  );
  if (!folder) throw new BridgeError("RESOURCE_OUT_OF_SCOPE", "The requested local workspace root is unavailable.");
  return folder;
}

function extensionIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && validExtensionId(item)).slice(0, 200)
    : [];
}

function validExtensionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string, limit: number): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : fallback;
}
