import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  InstanceDescriptorEnvelopeSchema,
  PublicInstanceSchema,
  REGISTRY_DIRECTORY_ENV,
  resolveInstanceDescriptorPath,
  resolveRegistryDirectories,
  resolveTransportDescriptor,
} from "../src/index.js";

const INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("bridge registry", () => {
  test("honors an explicit registry directory", () => {
    const root = path.resolve("test-registry");
    const directories = resolveRegistryDirectories({
      env: { [REGISTRY_DIRECTORY_ENV]: root },
      homeDirectory: path.resolve("unused-home"),
    });

    expect(directories.base).toBe(root);
    expect(directories.instances).toBe(path.join(root, "instances"));
    expect(directories.sockets).toBe(path.join(root, "sockets"));
    expect(resolveInstanceDescriptorPath(INSTANCE_ID, directories)).toBe(
      path.join(root, "instances", `${INSTANCE_ID}.json`),
    );
  });

  test("uses named pipes on Windows", () => {
    const directories = resolveRegistryDirectories({
      env: { [REGISTRY_DIRECTORY_ENV]: path.resolve("test-registry") },
    });
    const transport = resolveTransportDescriptor(INSTANCE_ID, directories, "win32");

    expect(transport.kind).toBe("named-pipe");
    expect(transport.endpoint).toContain(INSTANCE_ID);
  });

  test("rejects path-like instance IDs", () => {
    expect(() => resolveInstanceDescriptorPath("../escape")).toThrow(
      "Bridge instance IDs must be UUIDs.",
    );
  });

  test("recognizes old descriptor envelopes while keeping public results sanitized", () => {
    const descriptor = InstanceDescriptorEnvelopeSchema.parse({
      protocolVersion: BRIDGE_PROTOCOL_VERSION - 1,
      extensionVersion: "0.11.0",
      instanceId: INSTANCE_ID,
      pid: 1234,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      appName: "Visual Studio Code",
      appHost: "desktop",
      remoteName: null,
      workspaceTrusted: true,
      lifecycle: "ready",
      workspaceFolders: [],
      transport: { kind: "named-pipe", endpoint: `\\\\.\\pipe\\bridge-${INSTANCE_ID}` },
      authToken: "old-secret-token",
      oldProtocolField: true,
    });
    expect(descriptor.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION - 1);
    expect(() => PublicInstanceSchema.parse({
      protocolVersion: descriptor.protocolVersion,
      extensionVersion: descriptor.extensionVersion,
      instanceId: descriptor.instanceId,
      pid: descriptor.pid,
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.updatedAt,
      appName: descriptor.appName,
      appHost: descriptor.appHost,
      remoteName: descriptor.remoteName,
      workspaceTrusted: descriptor.workspaceTrusted,
      lifecycle: descriptor.lifecycle,
      workspaceFolders: descriptor.workspaceFolders,
      transportKind: descriptor.transport.kind,
      compatibility: "incompatible",
    })).not.toThrow();
    expect(() => PublicInstanceSchema.parse({ ...descriptor, compatibility: "incompatible" })).toThrow();
  });
});
