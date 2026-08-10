import { describe, expect, test } from "bun:test";

import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_DOMAINS,
  MCP_TOOL_NAMES,
  aggregateUsageInsights,
  publicToolCatalog,
  type UsageInsightEvent,
} from "../src/index.js";

describe("authoritative MCP tool catalog", () => {
  test("derives all names from one complete classified catalog", () => {
    expect(MCP_TOOL_CATALOG).toHaveLength(44);
    expect(MCP_TOOL_NAMES).toEqual(MCP_TOOL_CATALOG.map((tool) => tool.name));
    expect(new Set(MCP_TOOL_NAMES).size).toBe(44);
    const catalogDomains: string[] = [...new Set(MCP_TOOL_CATALOG.map((tool) => tool.domain))].sort();
    expect(catalogDomains).toEqual(Object.keys(MCP_TOOL_DOMAINS).sort());
    for (const tool of publicToolCatalog()) {
      expect(tool.domainLabel).toBe(MCP_TOOL_DOMAINS[tool.domain]);
      expect(tool.openWorld).toBe(tool.annotations.openWorldHint);
      if (tool.annotations.destructiveHint) expect(tool.intent).not.toBe("observe");
    }
  });

  test("produces deterministic evidence-based usage suggestions", () => {
    const now = new Date("2026-08-10T12:00:00.000Z");
    const events = [0, 1, 2].map((sequence): UsageInsightEvent => ({
      schemaVersion: 1,
      processSessionId: "5fb5ea27-1241-4fbb-b758-7c4f4ef015f2",
      sequence,
      toolName: "vscode_apply_change_set",
      domain: "editing",
      startedAt: "2026-08-10T11:59:58.000Z",
      finishedAt: "2026-08-10T11:59:59.000Z",
      outcome: "rejected",
      latencyBucket: "under1s",
      requestSizeBucket: "under1KiB",
      resultSizeBucket: "under1KiB",
      truncated: false,
      errorCode: "STALE_CHANGE_SET",
    }));
    const result = aggregateUsageInsights(events, 30, now);
    expect(result.totalCalls).toBe(3);
    expect(result.friction).toContainEqual({ name: "STALE_CHANGE_SET", count: 3 });
    expect(result.suggestions[0]).toContain("stale-state");
  });
});
