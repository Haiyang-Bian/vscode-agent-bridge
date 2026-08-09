export const BRIDGE_NAME = "vscode-agent-bridge" as const;
export const BRIDGE_RELEASE_VERSION = "0.5.1" as const;
export const BRIDGE_PROTOCOL_VERSION = 4 as const;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5_000;
export const MAX_RPC_MESSAGE_BYTES = 1_048_576;
export const DEFAULT_DOCUMENT_MAX_CHARACTERS = 65_536;
export const MAX_DOCUMENT_CHARACTERS = 200_000;
export const DEFAULT_RESULT_LIMIT = 200;
export const MAX_RESULT_LIMIT = 1_000;
export const DEFAULT_HOVER_MAX_CHARACTERS = 16_384;
export const MAX_HOVER_CHARACTERS = 65_536;
export const CHANGE_SET_TTL_MS = 10 * 60 * 1_000;
export const MAX_CHANGE_SET_DOCUMENTS = 50;
export const MAX_CHANGE_SET_EDITS = 1_000;
export const MAX_CHANGE_SET_REPLACEMENT_CHARACTERS = 500_000;
export const DEFAULT_CHECKPOINT_LIMIT = 50;
export const MAX_CHECKPOINT_LIMIT = 200;
export const MAX_EXPERIMENT_TITLE_CHARACTERS = 120;
export const MAX_EXPERIMENT_RATIONALE_CHARACTERS = 2_000;
export const MAX_EXPERIMENT_EVIDENCE_CHARACTERS = 2_000;
export const CODE_ACTION_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_TERMINAL_EXECUTION_LIMIT = 50;
export const MAX_TERMINAL_EXECUTION_LIMIT = 200;
export const DEFAULT_TERMINAL_OUTPUT_CHARACTERS = 65_536;
export const MAX_TERMINAL_OUTPUT_CHARACTERS = 200_000;
export const MAX_TERMINAL_EXECUTION_OUTPUT_BYTES = 1_048_576;
export const MAX_TERMINAL_WINDOW_OUTPUT_BYTES = 16 * 1_048_576;
export const CLOSED_TERMINAL_RETENTION_MS = 15 * 60 * 1_000;

export const BRIDGE_METHODS = {
  initialize: "bridge/initialize",
  getEditorContext: "editor/getContext",
  readDocument: "document/read",
  getDiagnostics: "languages/getDiagnostics",
  getDocumentSymbols: "languages/getDocumentSymbols",
  getDefinitions: "languages/getDefinitions",
  getReferences: "languages/getReferences",
  getHover: "languages/getHover",
  getExperiment: "experiment/get",
  listExperimentCheckpoints: "experiment/listCheckpoints",
  prepareTextEdits: "experiment/prepareTextEdits",
  prepareRename: "experiment/prepareRename",
  applyChangeSet: "experiment/applyChangeSet",
  recordExperimentEvidence: "experiment/recordEvidence",
  saveDocument: "document/save",
  formatDocument: "languages/formatDocument",
  listCodeActions: "languages/listCodeActions",
  applyCodeAction: "languages/applyCodeAction",
  listTerminals: "terminals/list",
  listTerminalExecutions: "terminals/listExecutions",
  readTerminalOutput: "terminals/readOutput",
} as const;

export const BRIDGE_CAPABILITIES = [
  "editor.getContext",
  "document.read",
  "languages.getDiagnostics",
  "languages.getDocumentSymbols",
  "languages.getDefinitions",
  "languages.getReferences",
  "languages.getHover",
  "experiment.get",
  "experiment.listCheckpoints",
  "experiment.prepareTextEdits",
  "experiment.prepareRename",
  "experiment.applyChangeSet",
  "experiment.recordEvidence",
  "document.save",
  "languages.formatDocument",
  "languages.listCodeActions",
  "languages.applyCodeAction",
  "terminals.list",
  "terminals.listExecutions",
  "terminals.readOutput",
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
  "vscode_get_experiment",
  "vscode_list_experiment_checkpoints",
  "vscode_prepare_text_edits",
  "vscode_prepare_rename",
  "vscode_apply_change_set",
  "vscode_record_experiment_evidence",
  "vscode_save_document",
  "vscode_format_document",
  "vscode_list_code_actions",
  "vscode_apply_code_action",
  "vscode_list_terminals",
  "vscode_list_terminal_executions",
  "vscode_read_terminal_output",
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
  "NO_ACTIVE_EXPERIMENT",
  "EXPERIMENT_ALREADY_ACTIVE",
  "EXPERIMENT_NOT_FOUND",
  "EXPERIMENT_NOT_OWNED",
  "CHANGE_SET_NOT_FOUND",
  "CHANGE_SET_EXPIRED",
  "CHANGE_SET_ALREADY_APPLIED",
  "STALE_CHANGE_SET",
  "EDIT_OUT_OF_SCOPE",
  "EDIT_LIMIT_EXCEEDED",
  "UNSUPPORTED_DOCUMENT_SCHEME",
  "SESSION_STORAGE_LIMIT",
  "SESSION_COVERAGE_INCOMPLETE",
  "GIT_UNAVAILABLE",
  "GIT_STATE_UNSUPPORTED",
  "WORKTREE_NOT_FOUND",
  "WORKTREE_NOT_CLEAN",
  "TARGET_MOVED",
  "SYNC_CONFLICTED",
  "ACCEPTED_COMMIT_REQUIRED",
  "PROMOTION_RECOVERY_REQUIRED",
  "POLICY_DENIED",
  "SAVE_FAILED",
  "FORMAT_PROVIDER_UNAVAILABLE",
  "CODE_ACTION_NOT_FOUND",
  "CODE_ACTION_EXPIRED",
  "CODE_ACTION_ALREADY_APPLIED",
  "CODE_ACTION_UNSUPPORTED",
  "TERMINAL_NOT_FOUND",
  "TERMINAL_EXECUTION_NOT_FOUND",
  "TERMINAL_OUTPUT_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
