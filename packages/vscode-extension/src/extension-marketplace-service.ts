import { randomUUID } from "node:crypto";

import {
  BridgeError,
  type ApplyExtensionInstallResult,
  type ExtensionCandidate,
  type PreparedExtension,
  type PreparedExtensionInstall,
  type SearchExtensionsResult,
} from "@vscode-agent-bridge/protocol";

import {
  OFFICIAL_EXTENSION_MAINTAINER_DIRECTORY_VERSION,
  isOfficialExtensionPublisher,
} from "./extension-maintainers.js";
import { MarketplaceClient, type MarketplaceExtensionVersion } from "./marketplace-client.js";

const CANDIDATE_TTL_MS = 15 * 60 * 1_000;
const PLAN_TTL_MS = 10 * 60 * 1_000;
const MAX_INSTALL_GRAPH = 20;

export interface InstalledExtensionState {
  readonly extensionId: string;
  readonly version: string;
  readonly publisher: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly dependencies: readonly string[];
  readonly extensionPack: readonly string[];
}

export interface NativeExtensionInstaller {
  install(extensionId: string, plannedVersion: string): Promise<{
    readonly status: "installed" | "pendingUserTrust" | "pendingReload" | "userActionRequired";
    readonly installedVersion: string | null;
    readonly usedNativeInstallCommand: boolean;
  }>;
}

interface CandidateRecord {
  readonly candidate: ExtensionCandidate;
  readonly expiresAt: number;
}

interface PlanRecord {
  readonly plan: PreparedExtensionInstall;
  readonly extensionGraph: readonly PreparedExtension[];
  readonly rootUri: string;
  readonly expiresAt: number;
  used: boolean;
}

export class ExtensionMarketplaceService {
  readonly #instanceId: string;
  readonly #client: MarketplaceClient;
  readonly #installer: NativeExtensionInstaller;
  readonly #vscodeVersion: string;
  readonly #targetPlatform: string;
  readonly #getInstalled: () => readonly InstalledExtensionState[];
  readonly #candidates = new Map<string, CandidateRecord>();
  readonly #plans = new Map<string, PlanRecord>();

  constructor(options: {
    readonly instanceId: string;
    readonly client: MarketplaceClient;
    readonly installer: NativeExtensionInstaller;
    readonly vscodeVersion: string;
    readonly targetPlatform: string;
    readonly getInstalled: () => readonly InstalledExtensionState[];
  }) {
    this.#instanceId = options.instanceId;
    this.#client = options.client;
    this.#installer = options.installer;
    this.#vscodeVersion = options.vscodeVersion;
    this.#targetPlatform = options.targetPlatform;
    this.#getInstalled = options.getInstalled;
  }

  async search(
    query: string,
    offset: number,
    limit: number,
    recommendations: ReadonlySet<string>,
  ): Promise<SearchExtensionsResult> {
    this.#prune();
    const installed = this.#getInstalled();
    const installedById = new Map(installed.map((extension) => [extension.extensionId.toLowerCase(), extension]));
    const marketplace = await this.#client.search({
      query,
      vscodeVersion: this.#vscodeVersion,
      targetPlatform: this.#targetPlatform,
      pageSize: 100,
    });
    const byId = new Map<string, ExtensionCandidate>();
    for (const extension of marketplace) {
      const local = installedById.get(extension.extensionId.toLowerCase());
      const candidate = this.#candidateFromMarketplace(extension, local, recommendations);
      byId.set(extension.extensionId.toLowerCase(), candidate);
    }
    const normalizedQuery = query.toLowerCase();
    for (const local of installed) {
      if (
        !local.extensionId.toLowerCase().includes(normalizedQuery) &&
        !local.displayName.toLowerCase().includes(normalizedQuery) &&
        !local.publisher.toLowerCase().includes(normalizedQuery)
      ) continue;
      const key = local.extensionId.toLowerCase();
      if (!byId.has(key)) byId.set(key, this.#candidateFromInstalled(local, recommendations));
    }
    const sorted = [...byId.values()]
      .sort(compareCandidates)
      .map((candidate, rank) => ({ ...candidate, rank }));
    const expiresAt = Date.now() + CANDIDATE_TTL_MS;
    for (const candidate of sorted) {
      this.#candidates.set(candidate.candidateId, { candidate, expiresAt });
    }
    const page = sorted.slice(offset, offset + limit);
    return {
      instanceId: this.#instanceId,
      candidates: page,
      returnedCount: page.length,
      totalCount: sorted.length,
      truncated: offset + page.length < sorted.length,
      cacheExpiresAt: new Date(expiresAt).toISOString(),
      maintainerDirectoryVersion: OFFICIAL_EXTENSION_MAINTAINER_DIRECTORY_VERSION,
    };
  }

  async prepare(
    sessionId: string,
    rootUri: string,
    candidateId: string,
  ): Promise<PreparedExtensionInstall> {
    this.#prune();
    const record = this.#candidates.get(candidateId);
    if (!record) {
      throw new BridgeError("EXTENSION_CANDIDATE_NOT_FOUND", "The listed extension candidate was not found.");
    }
    if (record.expiresAt <= Date.now()) {
      this.#candidates.delete(candidateId);
      throw new BridgeError("EXTENSION_CANDIDATE_EXPIRED", "The extension candidate expired; search again.");
    }
    if (!record.candidate.installable) {
      throw new BridgeError("EXTENSION_INSTALL_UNSUPPORTED", "The selected extension cannot be installed by the Bridge.");
    }
    const primary = await this.#client.findExact(
      record.candidate.extensionId,
      this.#vscodeVersion,
      this.#targetPlatform,
    );
    if (!primary || primary.version !== record.candidate.version) {
      throw new BridgeError("EXTENSION_CANDIDATE_EXPIRED", "The Marketplace candidate changed; search again.");
    }
    const graph = await this.#resolveGraph(primary);
    const installed = new Map(this.#getInstalled().map((item) => [item.extensionId.toLowerCase(), item.version]));
    assertNoVersionChanges(graph, installed);
    const planId = randomUUID();
    const expiresAt = Date.now() + PLAN_TTL_MS;
    const plan: PreparedExtensionInstall = {
      instanceId: this.#instanceId,
      sessionId,
      planId,
      extension: toPrepared(primary),
      dependencies: graph.slice(1).map(toPrepared),
      targetProfile: "current",
      expiresAt: new Date(expiresAt).toISOString(),
      alreadyInstalled: installed.get(primary.extensionId.toLowerCase()) === primary.version,
      recoverability: "none",
    };
    this.#plans.set(planId, { plan, extensionGraph: graph.map(toPrepared), rootUri, expiresAt, used: false });
    return plan;
  }

  async apply(sessionId: string, rootUri: string, planId: string): Promise<ApplyExtensionInstallResult> {
    this.#prune();
    const record = this.#plans.get(planId);
    if (!record) throw new BridgeError("EXTENSION_CANDIDATE_NOT_FOUND", "The extension install plan was not found.");
    if (record.used || record.expiresAt <= Date.now()) {
      throw new BridgeError("EXTENSION_CANDIDATE_EXPIRED", "The extension install plan expired or was already used.");
    }
    if (record.plan.sessionId !== sessionId || record.rootUri !== rootUri) {
      throw new BridgeError("EXPERIMENT_NOT_OWNED", "The extension install plan belongs to another experiment.");
    }
    record.used = true;
    for (const planned of record.extensionGraph) {
      const current = await this.#client.findExact(
        planned.extensionId,
        this.#vscodeVersion,
        this.#targetPlatform,
      );
      if (!current || current.version !== planned.version || current.publisher !== planned.publisher) {
        throw new BridgeError("EXTENSION_CANDIDATE_EXPIRED", "The prepared Marketplace install graph changed.");
      }
    }
    const primary = record.plan.extension;
    const installedBefore = this.#getInstalled().find(
      (item) => item.extensionId.toLowerCase() === primary.extensionId.toLowerCase(),
    );
    if (installedBefore?.version === primary.version) {
      return this.#result(record.plan, "alreadyInstalled", primary.version, false);
    }
    const result = await this.#installer.install(primary.extensionId, primary.version);
    if (result.status === "installed" && result.installedVersion !== primary.version) {
      throw new BridgeError("EXTENSION_INSTALL_FAILED", "VS Code installed a different extension version than the prepared plan.");
    }
    return this.#result(record.plan, result.status, result.installedVersion, result.usedNativeInstallCommand);
  }

  async #resolveGraph(primary: MarketplaceExtensionVersion): Promise<MarketplaceExtensionVersion[]> {
    const result: MarketplaceExtensionVersion[] = [];
    const queue = [primary];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift()!;
      const key = next.extensionId.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      result.push(next);
      if (result.length > MAX_INSTALL_GRAPH) {
        throw new BridgeError("EXTENSION_INSTALL_UNSUPPORTED", "The extension dependency graph exceeds twenty members.");
      }
      for (const dependencyId of [...next.dependencies, ...next.extensionPack]) {
        if (visited.has(dependencyId.toLowerCase())) continue;
        const dependency = await this.#client.findExact(
          dependencyId,
          this.#vscodeVersion,
          this.#targetPlatform,
        );
        if (!dependency) {
          throw new BridgeError("EXTENSION_INSTALL_UNSUPPORTED", "The extension dependency graph could not be resolved completely.");
        }
        queue.push(dependency);
      }
    }
    return result;
  }

  #candidateFromMarketplace(
    extension: MarketplaceExtensionVersion,
    installed: InstalledExtensionState | undefined,
    recommendations: ReadonlySet<string>,
  ): ExtensionCandidate {
    const official = isOfficialExtensionPublisher(extension.publisher);
    return {
      candidateId: randomUUID(),
      extensionId: extension.extensionId,
      version: extension.version,
      publisher: extension.publisher,
      displayName: extension.displayName,
      shortDescription: extension.shortDescription,
      source: installed?.builtIn ? "builtIn" : installed ? "installed" : "marketplace",
      official,
      officialDirectoryVersion: official ? OFFICIAL_EXTENSION_MAINTAINER_DIRECTORY_VERSION : null,
      verifiedPublisher: extension.verifiedPublisher,
      installed: Boolean(installed),
      installedVersion: installed?.version ?? null,
      workspaceRecommended: recommendations.has(extension.extensionId.toLowerCase()),
      targetPlatform: extension.targetPlatform,
      lastUpdated: extension.lastUpdated,
      dependencies: [...extension.dependencies],
      extensionPack: [...extension.extensionPack],
      repositoryUrl: extension.repositoryUrl,
      license: extension.license,
      installable: !installed?.builtIn,
      rank: 0,
    };
  }

  #candidateFromInstalled(
    installed: InstalledExtensionState,
    recommendations: ReadonlySet<string>,
  ): ExtensionCandidate {
    const official = isOfficialExtensionPublisher(installed.publisher);
    return {
      candidateId: randomUUID(),
      extensionId: installed.extensionId,
      version: installed.version,
      publisher: installed.publisher,
      displayName: installed.displayName,
      shortDescription: null,
      source: installed.builtIn ? "builtIn" : "installed",
      official,
      officialDirectoryVersion: official ? OFFICIAL_EXTENSION_MAINTAINER_DIRECTORY_VERSION : null,
      verifiedPublisher: false,
      installed: true,
      installedVersion: installed.version,
      workspaceRecommended: recommendations.has(installed.extensionId.toLowerCase()),
      targetPlatform: null,
      lastUpdated: null,
      dependencies: [...installed.dependencies],
      extensionPack: [...installed.extensionPack],
      repositoryUrl: null,
      license: null,
      installable: !installed.builtIn,
      rank: 0,
    };
  }

  #result(
    plan: PreparedExtensionInstall,
    status: ApplyExtensionInstallResult["status"],
    installedVersion: string | null,
    usedNativeInstallCommand: boolean,
  ): ApplyExtensionInstallResult {
    return {
      instanceId: this.#instanceId,
      sessionId: plan.sessionId,
      planId: plan.planId,
      extensionId: plan.extension.extensionId,
      plannedVersion: plan.extension.version,
      installedVersion,
      status,
      pendingUserTrust: status === "pendingUserTrust",
      pendingReload: status === "pendingReload",
      userActionRequired: status === "userActionRequired" || status === "pendingUserTrust",
      usedNativeInstallCommand,
      recoverability: "none",
    };
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, record] of this.#candidates) if (record.expiresAt <= now) this.#candidates.delete(id);
    for (const [id, record] of this.#plans) if (record.expiresAt <= now || record.used) this.#plans.delete(id);
  }
}

function toPrepared(extension: MarketplaceExtensionVersion): PreparedExtension {
  return {
    extensionId: extension.extensionId,
    version: extension.version,
    publisher: extension.publisher,
    official: isOfficialExtensionPublisher(extension.publisher),
    verifiedPublisher: extension.verifiedPublisher,
  };
}

function compareCandidates(left: ExtensionCandidate, right: ExtensionCandidate): number {
  const bucket = (candidate: ExtensionCandidate): number =>
    candidate.source === "builtIn" ? 0
      : candidate.installed ? 1
        : candidate.workspaceRecommended ? 2
          : candidate.official ? 3
            : candidate.verifiedPublisher ? 4
              : 5;
  return bucket(left) - bucket(right) || left.displayName.localeCompare(right.displayName) || left.extensionId.localeCompare(right.extensionId);
}

function assertNoVersionChanges(
  graph: readonly MarketplaceExtensionVersion[],
  installed: ReadonlyMap<string, string>,
): void {
  for (const extension of graph) {
    const current = installed.get(extension.extensionId.toLowerCase());
    if (current && current !== extension.version) {
      throw new BridgeError(
        "EXTENSION_INSTALL_UNSUPPORTED",
        "Installing a different version over an existing extension is not supported.",
      );
    }
  }
}
