import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearLocalUsageInsights,
  createLocalUsageInsightsReport,
  readLocalUsageInsights,
} from "../src/local-usage-insights.js";

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-extension-insights-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("extension-side local usage insight management", () => {
  test("reads, exports and clears only aggregate event data", async () => {
    const directory = path.join(temporaryRoot, "insights");
    await mkdir(directory, { recursive: true });
    const observedAt = new Date().toISOString();
    await writeFile(
      path.join(directory, "session.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        processSessionId: "5fb5ea27-1241-4fbb-b758-7c4f4ef015f2",
        sequence: 0,
        toolName: "vscode_get_hover",
        domain: "language",
        startedAt: observedAt,
        finishedAt: observedAt,
        outcome: "success",
        latencyBucket: "under1s",
        requestSizeBucket: "under1KiB",
        resultSizeBucket: "under1KiB",
        truncated: false,
        errorCode: null,
      })}\nnot-json\n`,
      "utf8",
    );

    expect((await readLocalUsageInsights(30, temporaryRoot)).totalCalls).toBe(1);
    const report = await createLocalUsageInsightsReport(temporaryRoot);
    expect(report).toContain("vscode_get_hover");
    expect(report).not.toContain("not-json");
    expect(await clearLocalUsageInsights(temporaryRoot)).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });
});
