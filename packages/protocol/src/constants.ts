export const BRIDGE_NAME = "vscode-agent-bridge" as const;
export const BRIDGE_RELEASE_VERSION = "0.2.0" as const;
export const BRIDGE_PROTOCOL_VERSION = 2 as const;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5_000;
export const MAX_RPC_MESSAGE_BYTES = 1_048_576;
export const DEFAULT_DOCUMENT_MAX_CHARACTERS = 65_536;
export const MAX_DOCUMENT_CHARACTERS = 200_000;
export const DEFAULT_RESULT_LIMIT = 200;
export const MAX_RESULT_LIMIT = 1_000;
export const DEFAULT_HOVER_MAX_CHARACTERS = 16_384;
export const MAX_HOVER_CHARACTERS = 65_536;

export const BRIDGE_METHODS = {
  initialize: "bridge/initialize",
  getEditorContext: "editor/getContext",
  readDocument: "document/read",
  getDiagnostics: "languages/getDiagnostics",
  getDocumentSymbols: "languages/getDocumentSymbols",
  getDefinitions: "languages/getDefinitions",
  getReferences: "languages/getReferences",
  getHover: "languages/getHover",
} as const;

export const BRIDGE_CAPABILITIES = [
  "editor.getContext",
  "document.read",
  "languages.getDiagnostics",
  "languages.getDocumentSymbols",
  "languages.getDefinitions",
  "languages.getReferences",
  "languages.getHover",
] as const;

export const MCP_TOOL_NAMES = [
  "vscode_list_instances",
  "vscode_get_editor_context",
  "vscode_read_document",
  "vscode_get_diagnostics",
  "vscode_get_document_symbols",
  "vscode_get_definitions",
  "vscode_get_references",
  "vscode_get_hover",
] as const;

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
  "NO_ACTIVE_EDITOR",
  "DOCUMENT_NOT_FOUND",
  "POSITION_OUT_OF_RANGE",
  "INTERNAL_ERROR",
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
