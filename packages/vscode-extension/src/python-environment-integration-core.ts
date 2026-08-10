import type { ExtensionIntegrationStateResult } from "@vscode-agent-bridge/protocol";

export interface ReviewedPythonEnvironmentInput {
  readonly interpreterPath?: string | undefined;
  readonly environmentType?: string | undefined;
  readonly environmentName?: string | undefined;
  readonly version?: {
    readonly major: number;
    readonly minor: number;
    readonly micro: number;
    readonly release?: {
      readonly level: "alpha" | "beta" | "candidate" | "final";
      readonly serial: number;
    } | undefined;
  } | undefined;
  readonly architecture?: string | undefined;
}

export function normalizeReviewedPythonEnvironment(
  environment: ReviewedPythonEnvironmentInput,
): NonNullable<ExtensionIntegrationStateResult["environment"]> {
  return {
    interpreterPath: bounded(environment.interpreterPath, 20_000),
    environmentType: bounded(environment.environmentType, 500),
    environmentName: bounded(environment.environmentName, 500),
    version: environment.version
      ? {
          major: environment.version.major,
          minor: environment.version.minor,
          micro: environment.version.micro,
          releaseLevel: environment.version.release?.level ?? null,
          releaseSerial: environment.version.release?.serial ?? null,
        }
      : null,
    architecture: bounded(environment.architecture, 100),
  };
}

function bounded(value: string | undefined, maxCharacters: number): string | null {
  if (!value) return null;
  return value.slice(0, maxCharacters);
}
