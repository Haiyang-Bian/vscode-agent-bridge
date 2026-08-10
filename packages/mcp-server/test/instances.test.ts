import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  BridgeError,
  type InstanceDescriptor,
} from "@vscode-agent-bridge/protocol";

import { discoverInstances, selectInstance, toPublicInstance } from "../src/instances.js";

const FIRST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_ID = "123e4567-e89b-42d3-a456-426614174001";

let temporaryRoot: string;
let instancesDirectory: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-test-"));
  instancesDirectory = path.join(temporaryRoot, "instances");
  await mkdir(instancesDirectory);
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("VS Code instance discovery", () => {
  test("loads valid descriptors and ignores malformed files", async () => {
    const descriptor = makeDescriptor(FIRST_ID);
    await writeFile(
      path.join(instancesDirectory, `${FIRST_ID}.json`),
      JSON.stringify(descriptor),
    );
    await writeFile(path.join(instancesDirectory, "malformed.json"), "not-json");

    expect(await discoverInstances(instancesDirectory)).toEqual([descriptor]);
  });

  test("does not expose authentication material", () => {
    const publicInstance = toPublicInstance(makeDescriptor(FIRST_ID));

    expect(publicInstance).not.toHaveProperty("authToken");
    expect(publicInstance).not.toHaveProperty("transport");
    expect(publicInstance.transportKind).toBe("named-pipe");
  });

  test("requires an explicit ID when multiple windows are registered", () => {
    const instances = [makeDescriptor(FIRST_ID), makeDescriptor(SECOND_ID)];

    try {
      selectInstance(instances);
      throw new Error("Expected selectInstance to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("AMBIGUOUS_INSTANCE");
    }

    expect(selectInstance(instances, SECOND_ID).instanceId).toBe(SECOND_ID);
  });
});

function makeDescriptor(instanceId: string): InstanceDescriptor {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    extensionVersion: BRIDGE_RELEASE_VERSION,
    instanceId,
    pid: 1234,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    appName: "Visual Studio Code",
    appHost: "desktop",
    remoteName: null,
    workspaceTrusted: true,
    workspaceFolders: [],
    transport: {
      kind: "named-pipe",
      endpoint: `\\.\pipe\vscode-agent-bridge-${instanceId}`,
    },
    authToken: "a".repeat(43),
  };
}
