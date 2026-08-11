import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  BridgeError,
  BRIDGE_PROTOCOL_VERSION,
  InstanceDescriptorEnvelopeSchema,
  InstanceDescriptorSchema,
  asBridgeError,
  resolveRegistryDirectories,
  type InstanceDescriptor,
  type InstanceDescriptorEnvelope,
  type PublicInstance,
} from "@vscode-agent-bridge/protocol";

import { probeBridge } from "./rpc-client.js";

export interface RegisteredInstance {
  readonly descriptor: InstanceDescriptorEnvelope;
  readonly compatibility: "current" | "incompatible";
}

export async function discoverInstances(
  instancesDirectory = resolveRegistryDirectories().instances,
): Promise<RegisteredInstance[]> {
  let entries;
  try {
    entries = await readdir(instancesDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  }

  const descriptors = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry): Promise<RegisteredInstance | null> => {
        try {
          const rawDescriptor = await readFile(path.join(instancesDirectory, entry.name), "utf8");
          const raw = JSON.parse(rawDescriptor) as unknown;
          const envelope = InstanceDescriptorEnvelopeSchema.safeParse(raw);
          if (!envelope.success) return null;
          if (envelope.data.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
            return { descriptor: envelope.data, compatibility: "incompatible" };
          }
          const current = InstanceDescriptorSchema.safeParse(raw);
          return current.success ? { descriptor: current.data, compatibility: "current" } : null;
        } catch {
          return null;
        }
      }),
  );

  return descriptors
    .filter((descriptor): descriptor is RegisteredInstance => descriptor !== null)
    .sort((left, right) => right.descriptor.updatedAt.localeCompare(left.descriptor.updatedAt));
}

export async function discoverLiveInstances(
  instancesDirectory = resolveRegistryDirectories().instances,
): Promise<RegisteredInstance[]> {
  const descriptors = await discoverInstances(instancesDirectory);
  const probes = await Promise.all(
    descriptors.map(async (registered) => {
      if (registered.compatibility === "incompatible") return registered;
      const descriptor = InstanceDescriptorSchema.parse(registered.descriptor);
      try {
        await probeBridge(descriptor);
        return registered;
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (bridgeError.code === "PROTOCOL_MISMATCH") {
          return { descriptor: registered.descriptor, compatibility: "incompatible" } satisfies RegisteredInstance;
        }
        if (
          bridgeError.code === "INSTANCE_UNAVAILABLE" ||
          bridgeError.code === "AUTHENTICATION_FAILED"
        ) {
          await rm(path.join(instancesDirectory, `${descriptor.instanceId}.json`), {
            force: true,
          }).catch(() => undefined);
        }
        return null;
      }
    }),
  );
  return probes.filter((descriptor): descriptor is RegisteredInstance => descriptor !== null);
}

export function selectInstance(
  instances: readonly RegisteredInstance[],
  requestedInstanceId?: string,
): InstanceDescriptor {
  if (requestedInstanceId) {
    const selected = instances.find((instance) => instance.descriptor.instanceId === requestedInstanceId);
    if (!selected) {
      throw new BridgeError(
        "NO_VSCODE_INSTANCE",
        `VS Code instance ${requestedInstanceId} is not registered.`,
        { availableInstanceIds: instances.map((instance) => instance.descriptor.instanceId) },
      );
    }
    return assertCompatible(selected);
  }

  if (instances.length === 0) {
    throw new BridgeError(
      "NO_VSCODE_INSTANCE",
      "No VS Code instances are registered. Start VS Code with the bridge extension enabled.",
    );
  }

  if (instances.length > 1) {
    throw new BridgeError(
      "AMBIGUOUS_INSTANCE",
      "Multiple VS Code instances are registered; provide instanceId explicitly.",
      { instances: instances.map(toPublicInstance) },
    );
  }

  return assertCompatible(instances[0]!);
}

export function toPublicInstance(registered: RegisteredInstance): PublicInstance {
  const descriptor = registered.descriptor;
  return {
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
    compatibility: registered.compatibility,
  };
}

function assertCompatible(registered: RegisteredInstance): InstanceDescriptor {
  if (registered.compatibility === "incompatible") {
    throw new BridgeError(
      "PROTOCOL_MISMATCH",
      `VS Code instance ${registered.descriptor.instanceId} uses Bridge protocol ${registered.descriptor.protocolVersion}; this MCP server requires protocol ${BRIDGE_PROTOCOL_VERSION}.`,
      {
        instanceId: registered.descriptor.instanceId,
        actualProtocolVersion: registered.descriptor.protocolVersion,
        expectedProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      },
    );
  }
  return InstanceDescriptorSchema.parse(registered.descriptor);
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
