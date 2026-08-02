import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
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
});
