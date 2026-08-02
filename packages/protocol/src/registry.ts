import os from "node:os";
import path from "node:path";

import type { TransportDescriptor } from "./schemas.js";

export const REGISTRY_DIRECTORY_ENV = "VSCODE_AGENT_BRIDGE_REGISTRY_DIR";

export interface RegistryResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

export interface RegistryDirectories {
  readonly base: string;
  readonly instances: string;
  readonly sockets: string;
}

export function resolveRegistryDirectories(
  options: RegistryResolutionOptions = {},
): RegistryDirectories {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const override = env[REGISTRY_DIRECTORY_ENV];

  let base: string;
  if (override) {
    base = path.resolve(override);
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
    base = path.join(localAppData, BRIDGE_DIRECTORY_NAME);
  } else if (env.XDG_RUNTIME_DIR) {
    base = path.join(env.XDG_RUNTIME_DIR, BRIDGE_DIRECTORY_NAME);
  } else {
    base = path.join(homeDirectory, `.${BRIDGE_DIRECTORY_NAME}`);
  }

  return {
    base,
    instances: path.join(base, "instances"),
    sockets: path.join(base, "sockets"),
  };
}

export function resolveInstanceDescriptorPath(
  instanceId: string,
  directories = resolveRegistryDirectories(),
): string {
  assertSafeInstanceId(instanceId);
  return path.join(directories.instances, `${instanceId}.json`);
}

export function resolveTransportDescriptor(
  instanceId: string,
  directories = resolveRegistryDirectories(),
  platform: NodeJS.Platform = process.platform,
): TransportDescriptor {
  assertSafeInstanceId(instanceId);

  if (platform === "win32") {
    return {
      kind: "named-pipe",
      endpoint: `\\\\.\\pipe\\${BRIDGE_DIRECTORY_NAME}-${instanceId}`,
    };
  }

  return {
    kind: "unix-socket",
    endpoint: path.join(directories.sockets, `${instanceId}.sock`),
  };
}

const BRIDGE_DIRECTORY_NAME = "vscode-agent-bridge";
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSafeInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error("Bridge instance IDs must be UUIDs.");
  }
}
