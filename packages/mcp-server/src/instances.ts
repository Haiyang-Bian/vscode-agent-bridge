import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  BridgeError,
  InstanceDescriptorSchema,
  resolveRegistryDirectories,
  type InstanceDescriptor,
  type PublicInstance,
} from "@vscode-agent-bridge/protocol";

export async function discoverInstances(
  instancesDirectory = resolveRegistryDirectories().instances,
): Promise<InstanceDescriptor[]> {
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
      .map(async (entry) => {
        try {
          const rawDescriptor = await readFile(path.join(instancesDirectory, entry.name), "utf8");
          const parsedDescriptor = InstanceDescriptorSchema.safeParse(JSON.parse(rawDescriptor));
          return parsedDescriptor.success ? parsedDescriptor.data : null;
        } catch {
          return null;
        }
      }),
  );

  return descriptors
    .filter((descriptor): descriptor is InstanceDescriptor => descriptor !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function selectInstance(
  instances: readonly InstanceDescriptor[],
  requestedInstanceId?: string,
): InstanceDescriptor {
  if (requestedInstanceId) {
    const selected = instances.find((instance) => instance.instanceId === requestedInstanceId);
    if (!selected) {
      throw new BridgeError(
        "NO_VSCODE_INSTANCE",
        `VS Code instance ${requestedInstanceId} is not registered.`,
        { availableInstanceIds: instances.map((instance) => instance.instanceId) },
      );
    }
    return selected;
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

  return instances[0]!;
}

export function toPublicInstance(descriptor: InstanceDescriptor): PublicInstance {
  const { authToken: _authToken, transport, ...publicFields } = descriptor;
  return {
    ...publicFields,
    transportKind: transport.kind,
  };
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
