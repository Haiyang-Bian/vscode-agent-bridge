import { describe, expect, test } from "bun:test";

import {
  EXTENSION_INTEGRATION_CATALOG,
  describeExtensionIntegration,
  getExtensionIntegrationDescriptor,
  isPythonExtensionVersionSupported,
} from "../src/extension-integration-registry.js";

describe("reviewed extension adapter registry", () => {
  test("contains only the official Python active-environment integration", () => {
    expect(EXTENSION_INTEGRATION_CATALOG).toHaveLength(1);
    expect(EXTENSION_INTEGRATION_CATALOG[0]).toMatchObject({
      integrationId: "python.environment",
      extensionId: "ms-python.python",
      activationPolicy: "onStateRequest",
    });
    expect(getExtensionIntegrationDescriptor("python.environment")).toBeDefined();
    expect(getExtensionIntegrationDescriptor("publisher.arbitrary")).toBeUndefined();
  });

  test("fails closed outside the reviewed Python extension version window", () => {
    expect(isPythonExtensionVersionSupported("2024.23.0")).toBe(true);
    expect(isPythonExtensionVersionSupported("2026.4.0")).toBe(true);
    expect(isPythonExtensionVersionSupported("2026.4.0-alpha.1")).toBe(true);
    expect(isPythonExtensionVersionSupported("2024.22.9")).toBe(false);
    expect(isPythonExtensionVersionSupported("2027.0.0")).toBe(false);
    expect(isPythonExtensionVersionSupported("latest")).toBe(false);
  });

  test("reports installation compatibility without activating an extension", () => {
    const descriptor = EXTENSION_INTEGRATION_CATALOG[0];
    expect(describeExtensionIntegration(descriptor, undefined)).toMatchObject({
      installed: false,
      availability: "notInstalled",
    });
    expect(describeExtensionIntegration(descriptor, "2026.4.0")).toMatchObject({
      installed: true,
      availability: "available",
    });
    expect(describeExtensionIntegration(descriptor, "2028.1.0")).toMatchObject({
      installed: true,
      availability: "versionUnsupported",
    });
  });
});
