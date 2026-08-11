import { describe, expect, test } from "bun:test";

import {
  ApplyExtensionInstallInputSchema,
  ExtensionConfigurationResultSchema,
  GetExtensionConfigurationInputSchema,
  PrepareExtensionInstallInputSchema,
  SearchExtensionsInputSchema,
  UpdateExtensionConfigurationInputSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANDIDATE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HASH = "a".repeat(64);

describe("protocol v9 extension orchestration schemas", () => {
  test("bounds Marketplace search and two-phase install handles", () => {
    expect(SearchExtensionsInputSchema.parse({ instanceId: INSTANCE_ID, query: "python" }))
      .toMatchObject({ offset: 0, limit: 20 });
    expect(PrepareExtensionInstallInputSchema.parse({
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      rootUri: "file:///workspace",
      candidateId: CANDIDATE_ID,
      reason: "Install official language support.",
    })).toMatchObject({ candidateId: CANDIDATE_ID, sessionId: SESSION_ID });
    expect(ApplyExtensionInstallInputSchema.parse({
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      planId: PLAN_ID,
    })).toMatchObject({ planId: PLAN_ID });
  });

  test("guards declared configuration writes with target-value hashes", () => {
    expect(GetExtensionConfigurationInputSchema.parse({
      instanceId: INSTANCE_ID,
      extensionId: "ms-python.python",
      key: "python.defaultInterpreterPath",
      target: "workspaceFolder",
      rootUri: "file:///workspace",
    })).toMatchObject({ target: "workspaceFolder" });
    expect(UpdateExtensionConfigurationInputSchema.parse({
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      rootUri: "file:///workspace",
      extensionId: "ms-python.python",
      key: "python.analysis.typeCheckingMode",
      target: "workspace",
      expectedValueSha256: HASH,
      newValue: "strict",
      reason: "Use the strict analyzer for this experiment.",
    })).toMatchObject({ expectedValueSha256: HASH, newValue: "strict" });
    expect(() => UpdateExtensionConfigurationInputSchema.parse({
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      rootUri: "file:///workspace",
      extensionId: "ms-python.python",
      key: "python.analysis.typeCheckingMode",
      target: "workspace",
      expectedValueSha256: HASH,
      newValue: "x".repeat(100_001),
      reason: "Oversized value.",
    })).toThrow();
  });

  test("returns configuration hashes and risk classification without raw values", () => {
    const result = ExtensionConfigurationResultSchema.parse({
      instanceId: INSTANCE_ID,
      extensionId: "ms-python.python",
      key: "python.defaultInterpreterPath",
      target: "workspaceFolder",
      rootUri: "file:///workspace",
      declaredTypes: ["string"],
      scope: "resource",
      effectiveValueDefined: true,
      effectiveValueSha256: HASH,
      effectiveValueType: "string",
      targetValueSha256: HASH,
      targetValueDefined: true,
      targetValueType: "string",
      riskClass: "executableOrPath",
      sensitive: false,
    });
    expect(result).not.toHaveProperty("effectiveValue");
    expect(result).not.toHaveProperty("targetValue");
  });
});
