export const BRIDGE_NAME = "vscode-agent-bridge" as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5_000;
export const MAX_RPC_MESSAGE_BYTES = 1_048_576;

export const BRIDGE_METHODS = {
  initialize: "bridge/initialize",
  getEditorContext: "editor/getContext",
} as const;

export const BRIDGE_CAPABILITIES = ["editor.getContext"] as const;

export const BRIDGE_ERROR_CODES = [
  "NO_VSCODE_INSTANCE",
  "AMBIGUOUS_INSTANCE",
  "INSTANCE_UNAVAILABLE",
  "WORKSPACE_UNTRUSTED",
  "STALE_DOCUMENT_VERSION",
  "AUTHENTICATION_FAILED",
  "PROTOCOL_MISMATCH",
  "UNSUPPORTED_REMOTE",
  "INVALID_REQUEST",
  "TIMEOUT",
  "RESULT_TRUNCATED",
  "INTERNAL_ERROR",
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
