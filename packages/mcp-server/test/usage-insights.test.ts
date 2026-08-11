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

  test("rotates the active file and flushes concurrent records", async () => {
    const store = new UsageInsightStore(temporaryRoot, {
      maxActiveFileBytes: 1_024,
      pruneIntervalBytes: 512,
    });
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      store.track("vscode_list_instances", { index }, async () => ({ structuredContent: {} })),
    ));
    await store.flush();
    const insightDirectory = path.join(temporaryRoot, "insights");
    const files = await readdir(insightDirectory);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect((await stat(path.join(insightDirectory, file))).size).toBeLessThanOrEqual(1_024);
    }
    expect((await store.getInsights(30)).totalCalls).toBe(40);
  });

  test("prunes before append to keep the configured total capacity", async () => {
    const insightDirectory = path.join(temporaryRoot, "insights");
    await mkdir(insightDirectory, { recursive: true });
    await writeFile(path.join(insightDirectory, "old.jsonl"), "x".repeat(1_900));
    const store = new UsageInsightStore(temporaryRoot, { maxTotalBytes: 2_000 });
    await store.track("vscode_list_instances", {}, async () => ({ structuredContent: {} }));
    await store.flush();
    const sizes = await Promise.all(
      (await readdir(insightDirectory)).map(async (file) => (await stat(path.join(insightDirectory, file))).size),
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(2_000);
    expect(await readdir(insightDirectory)).toHaveLength(1);
  });

  test("repeats retention pruning after the five-minute interval", async () => {
    let now = new Date("2026-08-11T00:00:00.000Z");
    const store = new UsageInsightStore(temporaryRoot, { now: () => now });
    await store.track("vscode_list_instances", {}, async () => ({ structuredContent: {} }));
    await store.flush();
    const insightDirectory = path.join(temporaryRoot, "insights");
    const expired = path.join(insightDirectory, "expired-after-start.jsonl");
    await writeFile(expired, "{}\n");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(expired, old, old);
    now = new Date(now.getTime() + 5 * 60 * 1_000 + 1);
    await store.track("vscode_list_instances", {}, async () => ({ structuredContent: {} }));
    await store.flush();
    await expect(stat(expired)).rejects.toBeDefined();
  });
});
