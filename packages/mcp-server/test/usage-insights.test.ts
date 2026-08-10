import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { UsageInsightStore } from "../src/usage-insights.js";

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-insights-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("privacy-preserving local usage insights", () => {
  test("records only buckets and stable completion metadata", async () => {
    const store = new UsageInsightStore(temporaryRoot);
    await store.track(
      "vscode_read_document",
      { uri: "file:///private/alice/secret.ts", source: "do-not-record" },
      async () => ({ structuredContent: { truncated: true, content: "also-private" } }),
    );
    const result = await store.getInsights(30);
    expect(result.totalCalls).toBe(1);
    expect(result.tools).toContainEqual({ name: "vscode_read_document", count: 1 });
    expect(result.friction).toContainEqual({ name: "RESULT_TRUNCATED", count: 1 });

    const insightDirectory = path.join(temporaryRoot, "insights");
    const raw = await Promise.all(
      (await readdir(insightDirectory)).map((name) => readFile(path.join(insightDirectory, name), "utf8")),
    ).then((contents) => contents.join("\n"));
    expect(raw).not.toContain("private/alice");
    expect(raw).not.toContain("do-not-record");
    expect(raw).not.toContain("also-private");
  });

  test("removes expired files before appending a new process session", async () => {
    const insightDirectory = path.join(temporaryRoot, "insights");
    await mkdir(insightDirectory, { recursive: true });
    const expired = path.join(insightDirectory, "expired.jsonl");
    await writeFile(expired, "{}\n");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(expired, old, old);

    const store = new UsageInsightStore(temporaryRoot);
    await store.track("vscode_list_instances", {}, async () => ({ structuredContent: {} }));
    await store.getInsights(30);

    await expect(stat(expired)).rejects.toBeDefined();
    expect(await readdir(insightDirectory)).toHaveLength(1);
  });
});
