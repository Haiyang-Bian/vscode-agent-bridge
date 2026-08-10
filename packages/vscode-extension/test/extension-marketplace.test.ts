import { describe, expect, test } from "bun:test";

import {
  ExtensionMarketplaceService,
  type InstalledExtensionState,
  type NativeExtensionInstaller,
} from "../src/extension-marketplace-service.js";
import { MarketplaceClient, type MarketplaceHttpTransport } from "../src/marketplace-client.js";

const INSTANCE_ID = "018f6bb0-4a27-7b9a-8e4d-11c028c8051d";
const SESSION_ID = "028f6bb0-4a27-7b9a-8e4d-11c028c8051d";

describe("bounded Marketplace orchestration", () => {
  test("ranks installed, official and verified candidates without conflating verified with official", async () => {
    const service = createService(
      [gallery("ms-python", "python", "2026.10.0", true), gallery("vendor", "tool", "1.0.0", true)],
      [installed("local.python-tools", "1.0.0")],
    );
    const result = await service.search("python", 0, 20, new Set(["vendor.tool"]));

    expect(result.totalCount).toBe(3);
    expect(result.candidates.map((candidate) => candidate.extensionId)).toEqual([
      "local.python-tools",
      "vendor.tool",
      "ms-python.python",
    ]);
    expect(result.candidates.find((candidate) => candidate.extensionId === "ms-python.python")?.official).toBe(true);
    expect(result.candidates.find((candidate) => candidate.extensionId === "vendor.tool")?.official).toBe(false);
    expect(result.candidates.find((candidate) => candidate.extensionId === "vendor.tool")?.verifiedPublisher).toBe(true);
  });

  test("locks a dependency graph and applies the exact primary version once", async () => {
    const primary = gallery("ms-python", "python", "2026.10.0", true, ["ms-toolsai.jupyter"]);
    const dependency = gallery("ms-toolsai", "jupyter", "2026.8.0", true);
    const installer = new FakeInstaller("2026.10.0");
    const service = createService([primary, dependency], [], installer);
    const candidates = await service.search("python", 0, 20, new Set());
    const candidate = candidates.candidates.find((item) => item.extensionId === "ms-python.python")!;
    const plan = await service.prepare(SESSION_ID, "file:///workspace", candidate.candidateId);

    expect(plan.extension.version).toBe("2026.10.0");
    expect(plan.dependencies.map((item) => item.extensionId)).toEqual(["ms-toolsai.jupyter"]);
    const result = await service.apply(SESSION_ID, "file:///workspace", plan.planId);
    expect(result.status).toBe("installed");
    expect(installer.calls).toEqual([{ extensionId: "ms-python.python", version: "2026.10.0" }]);
    await expect(service.apply(SESSION_ID, "file:///workspace", plan.planId)).rejects.toMatchObject({
      code: "EXTENSION_CANDIDATE_NOT_FOUND",
    });
  });

  test("fails closed for malformed responses and installed-version changes", async () => {
    const malformed = new MarketplaceClient({ transport: async () => "{}" });
    await expect(
      malformed.search({ query: "python", vscodeVersion: "1.95.0", targetPlatform: "win32-x64" }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });

    const service = createService(
      [gallery("ms-python", "python", "2.0.0", true)],
      [installed("ms-python.python", "1.0.0")],
    );
    const result = await service.search("python", 0, 20, new Set());
    await expect(
      service.prepare(SESSION_ID, "file:///workspace", result.candidates[0]!.candidateId),
    ).rejects.toMatchObject({ code: "EXTENSION_INSTALL_UNSUPPORTED" });
  });

  test("refuses an unresolved or oversized dependency graph", async () => {
    const missing = createService(
      [gallery("vendor", "root", "1.0.0", false, ["vendor.missing"])],
      [],
    );
    const candidates = await missing.search("root", 0, 20, new Set());
    await expect(
      missing.prepare(SESSION_ID, "file:///workspace", candidates.candidates[0]!.candidateId),
    ).rejects.toMatchObject({ code: "EXTENSION_INSTALL_UNSUPPORTED" });
  });
});

class FakeInstaller implements NativeExtensionInstaller {
  readonly calls: Array<{ extensionId: string; version: string }> = [];
  readonly #version: string;

  constructor(version: string) {
    this.#version = version;
  }

  async install(extensionId: string, version: string) {
    this.calls.push({ extensionId, version });
    return {
      status: "installed" as const,
      installedVersion: this.#version,
      usedNativeInstallCommand: true,
    };
  }
}

function createService(
  galleryExtensions: GalleryFixture[],
  installedExtensions: InstalledExtensionState[],
  installer: NativeExtensionInstaller = new FakeInstaller("1.0.0"),
): ExtensionMarketplaceService {
  const transport: MarketplaceHttpTransport = async () => {
    const extensions = galleryExtensions.map(toGalleryResponse);
    return JSON.stringify({ results: [{ extensions }] });
  };
  return new ExtensionMarketplaceService({
    instanceId: INSTANCE_ID,
    client: new MarketplaceClient({ transport }),
    installer,
    vscodeVersion: "1.95.0",
    targetPlatform: "win32-x64",
    getInstalled: () => installedExtensions,
  });
}

interface GalleryFixture {
  readonly publisher: { publisherName: string; isDomainVerified: boolean };
  readonly extensionName: string;
  readonly displayName: string;
  readonly shortDescription: string;
  readonly lastUpdated: string;
  readonly version: string;
  readonly dependencies: readonly string[];
}

function gallery(
  publisher: string,
  extensionName: string,
  version: string,
  verified: boolean,
  dependencies: readonly string[] = [],
): GalleryFixture {
  return {
    publisher: { publisherName: publisher, isDomainVerified: verified },
    extensionName,
    displayName: extensionName,
    shortDescription: `${extensionName} description`,
    lastUpdated: "2026-08-10T00:00:00.000Z",
    version,
    dependencies,
  };
}

function toGalleryResponse(extension: GalleryFixture) {
  return {
    extensionName: extension.extensionName,
    displayName: extension.displayName,
    shortDescription: extension.shortDescription,
    lastUpdated: extension.lastUpdated,
    publisher: extension.publisher,
    versions: [{
      version: extension.version,
      targetPlatform: "win32-x64",
      properties: extension.dependencies.length > 0
        ? [{ key: "Microsoft.VisualStudio.Code.ExtensionDependencies", value: extension.dependencies.join(",") }]
        : [],
    }],
  };
}

function installed(extensionId: string, version: string): InstalledExtensionState {
  return {
    extensionId,
    version,
    publisher: extensionId.split(".")[0]!,
    displayName: extensionId,
    builtIn: false,
    dependencies: [],
    extensionPack: [],
  };
}
