import {
  PYTHON_ENVIRONMENT_INTEGRATION_ID,
  PYTHON_EXTENSION_ID,
  PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE,
  type ExtensionIntegrationSummary,
} from "@vscode-agent-bridge/protocol";

export interface ExtensionIntegrationDescriptor {
  readonly integrationId: typeof PYTHON_ENVIRONMENT_INTEGRATION_ID;
  readonly extensionId: typeof PYTHON_EXTENSION_ID;
  readonly displayName: string;
  readonly supportedVersionRange: typeof PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE;
  readonly activationPolicy: "onStateRequest";
  readonly dataSensitivity: "workspaceMetadata";
}

export const EXTENSION_INTEGRATION_CATALOG = [
  {
    integrationId: PYTHON_ENVIRONMENT_INTEGRATION_ID,
    extensionId: PYTHON_EXTENSION_ID,
    displayName: "Python active environment",
    supportedVersionRange: PYTHON_EXTENSION_SUPPORTED_VERSION_RANGE,
    activationPolicy: "onStateRequest",
    dataSensitivity: "workspaceMetadata",
  },
] as const satisfies readonly ExtensionIntegrationDescriptor[];

export function getExtensionIntegrationDescriptor(
  integrationId: string,
): ExtensionIntegrationDescriptor | undefined {
  return EXTENSION_INTEGRATION_CATALOG.find(
    (integration) => integration.integrationId === integrationId,
  );
}

export function describeExtensionIntegration(
  descriptor: ExtensionIntegrationDescriptor,
  installedVersion: string | undefined,
): ExtensionIntegrationSummary {
  const installed = installedVersion !== undefined;
  const versionSupported = installed && isPythonExtensionVersionSupported(installedVersion);
  return {
    ...descriptor,
    installed,
    installedVersion: installedVersion ?? null,
    availability: !installed
      ? "notInstalled"
      : versionSupported
        ? "available"
        : "versionUnsupported",
  };
}

export function isPythonExtensionVersionSupported(version: string): boolean {
  const parsed = parseVersionTriple(version);
  if (!parsed) return false;
  return compareVersionTriples(parsed, [2024, 23, 0]) >= 0
    && compareVersionTriples(parsed, [2027, 0, 0]) < 0;
}

type VersionTriple = readonly [number, number, number];

function parseVersionTriple(version: string): VersionTriple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  if (!match) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

function compareVersionTriples(left: VersionTriple, right: VersionTriple): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
