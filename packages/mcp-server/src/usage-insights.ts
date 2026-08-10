import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  UsageInsightEventSchema,
  aggregateUsageInsights,
  getMcpToolCatalogEntry,
  resolveRegistryDirectories,
  type UsageInsightEvent,
  type UsageInsightsResult,
} from "@vscode-agent-bridge/protocol";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TOTAL_BYTES = 20 * 1_048_576;
const MAX_EVENT_BYTES = 16 * 1_024;

export class UsageInsightStore {
  readonly #sessionId = randomUUID();
  readonly #directory: string;
  readonly #filePath: string;
  #sequence = 0;
  #writeQueue = Promise.resolve();
  #pruned = false;

  constructor(baseDirectory = resolveRegistryDirectories().base) {
    this.#directory = path.join(baseDirectory, "insights");
    this.#filePath = path.join(
      this.#directory,
      `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${this.#sessionId}.jsonl`,
    );
  }

  async track<T>(toolName: string, input: unknown, operation: () => Promise<T>): Promise<T> {
    const started = new Date();
    let result: T | undefined;
    let thrown: unknown;
    try {
      result = await operation();
      return result;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const event = buildEvent({
        sessionId: this.#sessionId,
        sequence: this.#sequence++,
        toolName,
        input,
        result,
        thrown,
        started,
        finished: new Date(),
      });
      this.#writeQueue = this.#writeQueue
        .catch(() => undefined)
        .then(() => this.#append(event))
        .catch(() => undefined);
    }
  }

  async getInsights(days: number): Promise<UsageInsightsResult> {
    await this.#writeQueue.catch(() => undefined);
    return aggregateUsageInsights(await this.#readEvents(), days);
  }

  async #append(event: UsageInsightEvent): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (!this.#pruned) {
      this.#pruned = true;
      await pruneInsightFiles(this.#directory, this.#filePath);
    }
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) return;
    await appendFile(this.#filePath, line, { encoding: "utf8", mode: 0o600 });
  }

  async #readEvents(): Promise<UsageInsightEvent[]> {
    const files = await listInsightFiles(this.#directory);
    const events: UsageInsightEvent[] = [];
    for (const file of files) {
      let contents: string;
      try {
        contents = await readFile(file.path, "utf8");
      } catch {
        continue;
      }
      for (const line of contents.split(/\r?\n/u)) {
        if (!line || Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) continue;
        try {
          const parsed = UsageInsightEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
        } catch {
          // Ignore malformed or partially written final lines without exposing their contents.
        }
      }
    }
    return events;
  }
}

interface BuildEventOptions {
  readonly sessionId: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly input: unknown;
  readonly result: unknown;
  readonly thrown: unknown;
  readonly started: Date;
  readonly finished: Date;
}

function buildEvent(options: BuildEventOptions): UsageInsightEvent {
  const catalog = getMcpToolCatalogEntry(options.toolName);
  const errorCode = errorCodeFrom(options.result, options.thrown);
  const outcome = options.thrown
    ? "failed"
    : errorCode
      ? errorCode === "INTERNAL_ERROR" || errorCode === "TIMEOUT"
        ? "failed"
        : "rejected"
      : isNoOp(options.result)
        ? "no-op"
        : "success";
  return UsageInsightEventSchema.parse({
    schemaVersion: 1,
    processSessionId: options.sessionId,
    sequence: options.sequence,
    toolName: options.toolName,
    domain: catalog?.domain ?? "context",
    startedAt: options.started.toISOString(),
    finishedAt: options.finished.toISOString(),
    outcome,
    latencyBucket: latencyBucket(options.finished.getTime() - options.started.getTime()),
    requestSizeBucket: sizeBucket(serializedBytes(options.input)),
    resultSizeBucket: sizeBucket(serializedBytes(options.result)),
    truncated: hasTruncatedFlag(options.result),
    errorCode,
  });
}

function errorCodeFrom(result: unknown, thrown: unknown): string | null {
  if (thrown && typeof thrown === "object" && "code" in thrown && typeof thrown.code === "string") {
    return thrown.code;
  }
  if (!result || typeof result !== "object" || !("isError" in result) || result.isError !== true) {
    return null;
  }
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      item !== null && typeof item === "object" && item.type === "text" && typeof item.text === "string",
  )?.text;
  return text?.match(/^([A-Z][A-Z0-9_]+):/u)?.[1] ?? "INTERNAL_ERROR";
}

function isNoOp(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("structuredContent" in result)) return false;
  const content = result.structuredContent;
  return Boolean(
    content &&
      typeof content === "object" &&
      (("applied" in content && content.applied === false) ||
        ("changed" in content && content.changed === false)),
  );
}

function hasTruncatedFlag(value: unknown, depth = 0): boolean {
  if (depth > 3 || !value || typeof value !== "object") return false;
  if ("truncated" in value && value.truncated === true) return true;
  return Object.values(value).some((entry) => hasTruncatedFlag(entry, depth + 1));
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function latencyBucket(milliseconds: number): UsageInsightEvent["latencyBucket"] {
  if (milliseconds < 10) return "under10ms";
  if (milliseconds < 100) return "under100ms";
  if (milliseconds < 1_000) return "under1s";
  if (milliseconds < 10_000) return "under10s";
  return "over10s";
}

function sizeBucket(bytes: number): UsageInsightEvent["requestSizeBucket"] {
  if (bytes === 0) return "empty";
  if (bytes < 1_024) return "under1KiB";
  if (bytes < 16 * 1_024) return "under16KiB";
  if (bytes < 256 * 1_024) return "under256KiB";
  return "over256KiB";
}

async function pruneInsightFiles(directory: string, activeFile: string): Promise<void> {
  const files = await listInsightFiles(directory);
  const cutoff = Date.now() - RETENTION_MS;
  for (const file of files) {
    if (file.path !== activeFile && file.modifiedAt < cutoff) {
      await rm(file.path, { force: true }).catch(() => undefined);
    }
  }
  const retained = (await listInsightFiles(directory)).sort(
    (left, right) => left.modifiedAt - right.modifiedAt,
  );
  let total = retained.reduce((sum, file) => sum + file.size, 0);
  for (const file of retained) {
    if (total <= MAX_TOTAL_BYTES) break;
    if (file.path === activeFile) continue;
    await rm(file.path, { force: true }).catch(() => undefined);
    total -= file.size;
  }
}

async function listInsightFiles(
  directory: string,
): Promise<Array<{ path: string; size: number; modifiedAt: number }>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") || name.includes("/") || name.includes("\\")) continue;
    const filePath = path.join(directory, name);
    try {
      const metadata = await stat(filePath);
      if (metadata.isFile()) files.push({ path: filePath, size: metadata.size, modifiedAt: metadata.mtimeMs });
    } catch {
      // A concurrent process may remove an expired insight file.
    }
  }
  return files;
}
