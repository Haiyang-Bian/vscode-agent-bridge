import { describe, expect, test } from "bun:test";
import { ServiceInstallationSchema } from "../src/service.js";

describe("service installation contracts", () => {
  test("reads pre-rollback installation records with a null rollback reference", () => {
    const installation = ServiceInstallationSchema.parse({
      contractVersion: 1,
      version: "0.13.0",
      executablePath: "C:\\bridge\\vscode-agent-bridge-mcp.exe",
      executableSha256: "a".repeat(64),
      taskName: "VSCodeAgentBridge-test",
      codexConfigPath: null,
      installedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(installation.rollback).toBeNull();
    expect(installation.registryDirectory).toBeNull();
  });
});
