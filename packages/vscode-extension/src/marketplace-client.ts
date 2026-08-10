import https from "node:https";
import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";

import { z } from "zod";

import { BridgeError } from "@vscode-agent-bridge/protocol";

const MARKETPLACE_URL = new URL(
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
);
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MARKETPLACE_FLAGS = 1 | 4 | 16 | 64 | 256 | 512;

const PropertySchema = z
  .object({ key: z.string().max(500), value: z.string().max(100_000) })
  .passthrough();
const VersionSchema = z
  .object({
    version: z.string().min(1).max(200),
    targetPlatform: z.string().max(100).optional(),
    properties: z.array(PropertySchema).max(2_000).optional(),
  })
  .passthrough();
const GalleryExtensionSchema = z
  .object({
    extensionName: z.string().min(1).max(300),
    displayName: z.string().min(1).max(500),
    shortDescription: z.string().max(2_000).optional(),
    lastUpdated: z.string().max(100).optional(),
    publisher: z
      .object({
        publisherName: z.string().min(1).max(200),
        isDomainVerified: z.boolean().optional(),
      })
      .passthrough(),
    versions: z.array(VersionSchema).min(1).max(200),
  })
  .passthrough();
const GalleryResponseSchema = z
  .object({
    results: z
      .array(
        z
          .object({ extensions: z.array(GalleryExtensionSchema).max(1_000) })
          .passthrough(),
      )
      .min(1)
      .max(10),
  })
  .passthrough();

export interface MarketplaceExtensionVersion {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly publisher: string;
  readonly displayName: string;
  readonly shortDescription: string | null;
  readonly version: string;
  readonly targetPlatform: string | null;
  readonly lastUpdated: string | null;
  readonly verifiedPublisher: boolean;
  readonly dependencies: readonly string[];
  readonly extensionPack: readonly string[];
  readonly repositoryUrl: string | null;
  readonly license: string | null;
}

export interface MarketplaceSearchRequest {
  readonly query: string;
  readonly vscodeVersion: string;
  readonly targetPlatform: string;
  readonly pageSize?: number;
}

export interface MarketplaceHttpRequest {
  readonly url: URL;
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly proxyUrl: string | null;
}

export type MarketplaceHttpTransport = (request: MarketplaceHttpRequest) => Promise<string>;

export class MarketplaceClient {
  readonly #transport: MarketplaceHttpTransport;
  readonly #getProxyUrl: () => string | null;

  constructor(options: {
    readonly transport?: MarketplaceHttpTransport;
    readonly getProxyUrl?: () => string | null;
  } = {}) {
    this.#transport = options.transport ?? requestMarketplace;
    this.#getProxyUrl = options.getProxyUrl ?? (() => null);
  }

  async search(request: MarketplaceSearchRequest): Promise<MarketplaceExtensionVersion[]> {
    const query = request.query.trim();
    if (!query) return [];
    const body = JSON.stringify({
      filters: [
        {
          criteria: [
            { filterType: 10, value: query },
            { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            { filterType: 15, value: request.vscodeVersion },
            { filterType: 23, value: request.targetPlatform },
          ],
          pageNumber: 1,
          pageSize: Math.min(Math.max(request.pageSize ?? 100, 1), 100),
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: MARKETPLACE_FLAGS,
    });
    let text: string;
    try {
      text = await this.#transport({
        url: MARKETPLACE_URL,
        body,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        proxyUrl: normalizeProxy(this.#getProxyUrl()),
      });
    } catch {
      throw new BridgeError(
        "MARKETPLACE_UNAVAILABLE",
        "The Visual Studio Marketplace query capability is currently unavailable.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BridgeError("MARKETPLACE_UNAVAILABLE", "The Marketplace returned malformed JSON.");
    }
    const response = GalleryResponseSchema.safeParse(parsed);
    if (!response.success) {
      throw new BridgeError("MARKETPLACE_UNAVAILABLE", "The Marketplace response schema was not recognized.");
    }
    return response.data.results.flatMap((result) => result.extensions).flatMap(toMarketplaceExtension);
  }

  async findExact(
    extensionId: string,
    vscodeVersion: string,
    targetPlatform: string,
  ): Promise<MarketplaceExtensionVersion | null> {
    const candidates = await this.search({ query: extensionId, vscodeVersion, targetPlatform, pageSize: 100 });
    return candidates.find((candidate) => candidate.extensionId.toLowerCase() === extensionId.toLowerCase()) ?? null;
  }
}

async function requestMarketplace(request: MarketplaceHttpRequest): Promise<string> {
  const socket = request.proxyUrl
    ? await createProxyTunnel(new URL(request.proxyUrl), request.url, request.timeoutMs)
    : undefined;
  return new Promise<string>((resolve, reject) => {
    const outgoing = https.request(
      request.url,
      {
        method: "POST",
        agent: false,
        ...(socket ? { createConnection: () => socket } : {}),
        headers: {
          Accept: "application/json;api-version=7.2-preview.1",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(request.body),
          "User-Agent": "vscode-agent-bridge-marketplace",
        },
        timeout: request.timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Marketplace status ${response.statusCode ?? "unknown"}.`));
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        if (!contentType.includes("application/json")) {
          response.resume();
          reject(new Error("Marketplace returned a non-JSON response."));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > request.maxResponseBytes) {
            outgoing.destroy(new Error("Marketplace response exceeded the configured limit."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("Marketplace request timed out.")));
    outgoing.on("error", reject);
    outgoing.end(request.body);
  });
}

async function createProxyTunnel(proxy: URL, target: URL, timeoutMs: number): Promise<TLSSocket> {
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const proxySocket: Socket = proxy.protocol === "https:"
    ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
    : net.connect({ host: proxy.hostname, port: proxyPort });
  await waitForSocket(proxySocket, proxy.protocol === "https:" ? "secureConnect" : "connect", timeoutMs);
  const targetPort = Number(target.port || 443);
  const authorization = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  proxySocket.write(
    `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\n${authorization}Proxy-Connection: Keep-Alive\r\nConnection: Keep-Alive\r\n\r\n`,
  );
  const header = await readProxyResponseHeader(proxySocket, timeoutMs);
  if (!/^HTTP\/1\.[01] 200(?: |\r?$)/mu.test(header)) {
    proxySocket.destroy();
    throw new Error("The configured proxy rejected the Marketplace CONNECT request.");
  }
  const secureSocket = tls.connect({ socket: proxySocket, servername: target.hostname });
  await waitForSocket(secureSocket, "secureConnect", timeoutMs);
  return secureSocket;
}

async function waitForSocket(
  socket: Socket | TLSSocket,
  eventName: "connect" | "secureConnect",
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("The proxy connection timed out."));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onReady);
      socket.off("error", onError);
    };
    socket.once(eventName, onReady);
    socket.once("error", onError);
  });
}

async function readProxyResponseHeader(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("The proxy response timed out.")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16_384) {
        finish(new Error("The proxy response header exceeded the configured limit."));
        return;
      }
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const remainder = buffered.subarray(boundary + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      finish(undefined, buffered.subarray(0, boundary + 4).toString("latin1"));
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("The proxy closed the CONNECT response early."));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function toMarketplaceExtension(raw: z.infer<typeof GalleryExtensionSchema>): MarketplaceExtensionVersion[] {
  const version = raw.versions[0];
  if (!version) return [];
  const extensionId = `${raw.publisher.publisherName}.${raw.extensionName}`;
  if (!validExtensionId(extensionId)) return [];
  const properties = new Map((version.properties ?? []).map((property) => [property.key, property.value]));
  return [{
    extensionId,
    extensionName: raw.extensionName,
    publisher: raw.publisher.publisherName,
    displayName: raw.displayName,
    shortDescription: raw.shortDescription ?? null,
    version: version.version,
    targetPlatform: version.targetPlatform ?? null,
    lastUpdated: validDate(raw.lastUpdated) ? new Date(raw.lastUpdated!).toISOString() : null,
    verifiedPublisher: raw.publisher.isDomainVerified === true,
    dependencies: parseExtensionIds(properties.get("Microsoft.VisualStudio.Code.ExtensionDependencies")),
    extensionPack: parseExtensionIds(properties.get("Microsoft.VisualStudio.Code.ExtensionPack")),
    repositoryUrl: validUrl(properties.get("Microsoft.VisualStudio.Services.Links.Source")),
    license: bounded(properties.get("Microsoft.VisualStudio.Services.Content.License"), 1_000),
  }];
}

function parseExtensionIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(validExtensionId))].slice(0, 200);
}

function validExtensionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(value);
}

function validDate(value: string | undefined): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function validUrl(value: string | undefined): string | null {
  if (!value || value.length > 2_000) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function bounded(value: string | undefined, limit: number): string | null {
  return value && value.length <= limit ? value : null;
}

function normalizeProxy(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
