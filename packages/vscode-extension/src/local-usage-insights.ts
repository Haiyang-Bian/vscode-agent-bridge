import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  UsageInsightEventSchema,
  aggregateUsageInsights,
  resolveRegistryDirectories,
  type UsageInsightEvent,
  type UsageInsightsResult,
} from "@vscode-agent-bridge/protocol";

const MAX_EVENT_BYTES = 16 * 1_024;

export async function readLocalUsageInsights(
  days = 30,
  baseDirectory = resolveRegistryDirectories().base,
): Promise<UsageInsightsResult> {
  const events: UsageInsightEvent[] = [];
  for (const filePath of await insightFiles(baseDirectory)) {
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/u)) {
      if (!line || Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) continue;
      try {
        const parsed = UsageInsightEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // Ignore a malformed or concurrently appended final line.
      }
    }
  }
  return aggregateUsageInsights(events, days);
}

export async function clearLocalUsageInsights(
  baseDirectory = resolveRegistryDirectories().base,
): Promise<number> {
  const files = await insightFiles(baseDirectory);
  await Promise.all(files.map((filePath) => rm(filePath, { force: true })));
  return files.length;
}

export async function createLocalUsageInsightsReport(
  baseDirectory = resolveRegistryDirectories().base,
): Promise<string> {
  const insights = await readLocalUsageInsights(30, baseDirectory);
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      privacy: "Local aggregate only; no parameters, results, paths, source, terminal output, or debug values.",
      ...insights,
    },
    null,
    2,
  )}\n`;
}

async function insightFiles(baseDirectory: string): Promise<string[]> {
  const directory = path.join(baseDirectory, "insights");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl") && !name.includes("/") && !name.includes("\\"))
    .map((name) => path.join(directory, name));
}
