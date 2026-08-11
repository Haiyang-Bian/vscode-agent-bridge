import { describe, expect, test } from "bun:test";

import type { OutputSource } from "@vscode-agent-bridge/protocol";

import { selectAndSortOutputSources } from "../src/output-source-order.js";

describe("Output source inventory", () => {
  test("defaults to actionable sources ordered by readability, activity and recency", () => {
    const sources = [
      source("capability", "extensionCapability", false, "active", null, "A metadata capability"),
      source("inactive", "outputDocument", true, "inactive", "2026-08-11T01:00:00.000Z", "B readable"),
      source("active-old", "diagnostics", true, "active", "2026-08-11T01:00:00.000Z", "C active old"),
      source("active-new", "debugCapture", true, "active", "2026-08-11T02:00:00.000Z", "D active new"),
      source("unreadable", "taskCapture", false, "emitting", "2026-08-11T03:00:00.000Z", "E unreadable"),
    ];
    expect(selectAndSortOutputSources(sources, undefined).map((item) => item.sourceId)).toEqual([
      "active-new",
      "active-old",
      "inactive",
      "unreadable",
    ]);
  });

  test("returns extension capabilities only when explicitly requested", () => {
    const sources = [
      source("capability", "extensionCapability", false, "available", null, "Capability"),
      source("output", "outputDocument", true, "active", null, "Output"),
    ];
    expect(selectAndSortOutputSources(sources, ["extensionCapability"]).map((item) => item.sourceId)).toEqual(["capability"]);
  });
});

function source(
  sourceId: string,
  sourceType: OutputSource["sourceType"],
  canReadNow: boolean,
  status: OutputSource["status"],
  lastObservedAt: string | null,
  label: string,
): OutputSource {
  return {
    sourceId,
    extensionId: null,
    label,
    sourceType,
    status,
    coverage: sourceType === "extensionCapability" ? "metadataOnly" : "captured",
    canReadNow,
    lastObservedAt,
    errorCount: 0,
    warningCount: 0,
  };
}
