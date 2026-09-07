import type { ServiceErrorCode } from "@vscode-agent-bridge/protocol";

export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export function publicServiceError(error: unknown): { code: ServiceErrorCode; message: string } {
  return error instanceof ServiceError
    ? { code: error.code, message: error.message }
    : { code: "SERVICE_START_FAILED", message: "The local service operation failed." };
}
