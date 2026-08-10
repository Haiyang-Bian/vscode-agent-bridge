import { describe, expect, test } from "bun:test";

import {
  ExtensionIntegrationStateResultSchema,
  GetExtensionIntegrationStateInputSchema,
  ListExtensionIntegrationsInputSchema,
  PYTHON_ENVIRONMENT_INTEGRATION_ID,
  PYTHON_EXTENSION_ID,
  PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("protocol v10 bounded extension integration schemas", () => {
  test("accepts only the reviewed Python environment integration", () => {
    expect(ListExtensionIntegrationsInputSchema.parse({ instanceId: INSTANCE_ID })).toMatchObject({
      instanceId: INSTANCE_ID,
      offset: 0,
      limit: 20,
    });
    expect(GetExtensionIntegrationStateInputSchema.parse({
      instanceId: INSTANCE_ID,
      integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
      rootUri: "file:///workspace",
    })).toMatchObject({ integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID });
    expect(() => GetExtensionIntegrationStateInputSchema.parse({
      instanceId: INSTANCE_ID,
      integrationId: "publisher.arbitrary",
      rootUri: "file:///workspace",
    })).toThrow();
  });

  test("represents a missing Python extension without activation", () => {
    expect(ExtensionIntegrationStateResultSchema.parse({
      instanceId: INSTANCE_ID,
      integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
      extensionId: PYTHON_EXTENSION_ID,
      rootUri: "file:///workspace",
      installedVersion: null,
      status: "unavailable",
      reason: "notInstalled",
      activatedByRequest: false,
      environment: null,
      observedAt: "2026-08-10T00:00:00.000Z",
    })).toMatchObject({ status: "unavailable", activatedByRequest: false });
    expect(PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE).toBe(">=2024.23.0 <2027.0.0");
  });
});
