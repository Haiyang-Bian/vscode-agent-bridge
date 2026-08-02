import type { BridgeErrorCode } from "./constants.js";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: unknown;

  constructor(code: BridgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }

  return new BridgeError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unexpected bridge failure.",
  );
}
