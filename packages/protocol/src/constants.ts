export const BRIDGE_NAME = "vscode-agent-bridge" as const;
export const BRIDGE_RELEASE_VERSION = "0.12.0" as const;
export const BRIDGE_PROTOCOL_VERSION = 11 as const;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5_000;
export const INTERACTIVE_BRIDGE_TIMEOUT_MS = 90_000;
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
export const MAX_AGENT_EXPERIMENT_TITLE_CHARACTERS = 80;
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
export const MAX_CONFIGURATION_OPERATIONS = 100;
export const MAX_RESOURCE_OPERATIONS = 100;
export const MAX_RESOURCE_CHANGE_CHARACTERS = 500_000;
export const DEFAULT_TASK_LIMIT = 100;
export const MAX_TASK_LIMIT = 200;
export const TASK_EXECUTION_RETENTION_MS = 30 * 60 * 1_000;
export const PREPARED_WORKFLOW_TTL_MS = 30 * 60 * 1_000;
export const MAX_PREPARED_WORKFLOWS = 100;
export const MAX_PREPARED_TASK_BYTES = 128 * 1_024;
export const MAX_TASK_ARGUMENTS = 128;
export const MAX_TASK_ENVIRONMENT_VARIABLES = 64;
export const MAX_TASK_PROBLEM_MATCHERS = 16;
export const MAX_PREPARED_DEBUG_CONFIGURATION_BYTES = 100 * 1_024;
export const DOCUMENT_ACCESS_GRANT_TTL_MS = 10 * 60 * 1_000;
export const MAX_DOCUMENT_ACCESS_GRANTS = 500;
export const DEFAULT_DEBUG_ITEM_LIMIT = 100;
export const MAX_DEBUG_VARIABLES = 500;
export const MAX_DEBUG_STACK_FRAMES = 200;

export const BRIDGE_METHODS = {
  initialize: "bridge/initialize",
  getEditorContext: "editor/getContext",
  getWorkspaceSetup: "workspace/getSetup",
  getWorkspaceConfiguration: "workspace/getConfiguration",
  updateWorkspaceConfiguration: "workspace/updateConfiguration",
  readDocument: "document/read",
  getDiagnostics: "languages/getDiagnostics",
  getDocumentSymbols: "languages/getDocumentSymbols",
  getDefinitions: "languages/getDefinitions",
  getReferences: "languages/getReferences",
  getHover: "languages/getHover",
  getExperiment: "experiment/get",
  listExperiments: "experiment/list",
  startExperiment: "experiment/start",
  renameExperiment: "experiment/rename",
  createExperimentCheckpoint: "experiment/createCheckpoint",
  listExperimentCheckpoints: "experiment/listCheckpoints",
  prepareTextEdits: "experiment/prepareTextEdits",
  prepareRename: "experiment/prepareRename",
  prepareResourceChanges: "experiment/prepareResourceChanges",
  applyChangeSet: "experiment/applyChangeSet",
  recordExperimentEvidence: "experiment/recordEvidence",
  saveDocument: "document/save",
  formatDocument: "languages/formatDocument",
  listCodeActions: "languages/listCodeActions",
  applyCodeAction: "languages/applyCodeAction",
  listTerminals: "terminals/list",
  listTerminalExecutions: "terminals/listExecutions",
  readTerminalOutput: "terminals/readOutput",
  listTasks: "tasks/list",
  prepareTask: "tasks/prepare",
  persistTask: "tasks/persist",
  runTask: "tasks/run",
  listTaskExecutions: "tasks/listExecutions",
  terminateTask: "tasks/terminate",
  listDebugConfigurations: "debug/listConfigurations",
  prepareDebugConfiguration: "debug/prepareConfiguration",
  persistDebugConfiguration: "debug/persistConfiguration",
  startDebugSession: "debug/startSession",
  listDebugSessions: "debug/listSessions",
  getDebugState: "debug/getState",
  controlDebugSession: "debug/controlSession",
  listBreakpoints: "debug/listBreakpoints",
  updateBreakpoints: "debug/updateBreakpoints",
  evaluateDebugExpression: "debug/evaluate",
  setDebugVariable: "debug/setVariable",
  listExtensions: "extensions/list",
  getExtensionDetails: "extensions/getDetails",
  getExtensionConfigurationSchema: "extensions/getConfigurationSchema",
  getProfileContext: "extensions/getProfileContext",
  listOutputSources: "signals/listOutputSources",
  readVisibleOutput: "signals/readVisibleOutput",
  listDiagnosticEvents: "signals/listDiagnosticEvents",
  listDebugOutput: "debug/listOutput",
  readDebugOutput: "debug/readOutput",
  searchExtensions: "extensions/searchMarketplace",
  prepareExtensionInstall: "extensions/prepareInstall",
  applyExtensionInstall: "extensions/applyInstall",
  getExtensionConfiguration: "extensions/getConfiguration",
  updateExtensionConfiguration: "extensions/updateConfiguration",
  listExtensionIntegrations: "extensions/listIntegrations",
  getExtensionIntegrationState: "extensions/getIntegrationState",
} as const;

export const BRIDGE_CAPABILITIES = [
  "editor.getContext",
  "workspace.getSetup",
  "workspace.getConfiguration",
  "workspace.updateConfiguration",
  "document.read",
  "languages.getDiagnostics",
  "languages.getDocumentSymbols",
  "languages.getDefinitions",
  "languages.getReferences",
  "languages.getHover",
  "experiment.get",
  "experiment.list",
  "experiment.start",
  "experiment.rename",
  "experiment.createCheckpoint",
  "experiment.listCheckpoints",
  "experiment.prepareTextEdits",
  "experiment.prepareRename",
  "experiment.prepareResourceChanges",
  "experiment.applyChangeSet",
  "experiment.recordEvidence",
  "document.save",
  "languages.formatDocument",
  "languages.listCodeActions",
  "languages.applyCodeAction",
  "terminals.list",
  "terminals.listExecutions",
  "terminals.readOutput",
  "tasks.list",
  "tasks.prepare",
  "tasks.persist",
  "tasks.run",
  "tasks.listExecutions",
  "tasks.terminate",
  "debug.listConfigurations",
  "debug.prepareConfiguration",
  "debug.persistConfiguration",
  "debug.startSession",
  "debug.listSessions",
  "debug.getState",
  "debug.controlSession",
  "debug.listBreakpoints",
  "debug.updateBreakpoints",
  "debug.evaluate",
  "debug.setVariable",
  "extensions.list",
  "extensions.getDetails",
  "extensions.getConfigurationSchema",
  "extensions.getProfileContext",
  "signals.listOutputSources",
  "signals.readVisibleOutput",
  "signals.listDiagnosticEvents",
  "debug.listOutput",
  "debug.readOutput",
  "extensions.searchMarketplace",
  "extensions.prepareInstall",
  "extensions.applyInstall",
  "extensions.getConfiguration",
  "extensions.updateConfiguration",
  "extensions.listIntegrations",
  "extensions.getIntegrationState",
] as const;

export const BRIDGE_ERROR_CODES = [
  "NO_VSCODE_INSTANCE",
  "AMBIGUOUS_INSTANCE",
  "INSTANCE_UNAVAILABLE",
  "BRIDGE_INITIALIZING",
  "BRIDGE_DEGRADED",
  "REQUEST_CANCELLED",
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
  "DOCUMENT_ACCESS_DENIED",
  "DOCUMENT_ACCESS_GRANT_EXPIRED",
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
  "WORKSPACE_ONBOARDING_REQUIRED",
  "WORKSPACE_ONBOARDING_DECLINED",
  "WORKSPACE_CONFIGURATION_INVALID",
  "BRIDGE_DISABLED",
  "EXPERIMENT_UPGRADE_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_ALREADY_EXISTS",
  "RESOURCE_OUT_OF_SCOPE",
  "RESOURCE_TYPE_UNSUPPORTED",
  "RESOURCE_PRECONDITION_FAILED",
  "RESOURCE_RECOVERY_REQUIRED",
  "WORKSPACE_CONFIGURATION_TARGET_DENIED",
  "DEFERRED_EXECUTION_DENIED",
  "TASK_NOT_FOUND",
  "TASK_PREPARATION_NOT_FOUND",
  "TASK_PREPARATION_EXPIRED",
  "TASK_ALREADY_EXISTS",
  "TASK_CHANGED",
  "TASK_START_FAILED",
  "TASK_EXECUTION_NOT_FOUND",
  "TASK_TERMINATION_FAILED",
  "DEBUG_CONFIGURATION_NOT_FOUND",
  "DEBUG_CONFIGURATION_PREPARATION_NOT_FOUND",
  "DEBUG_CONFIGURATION_PREPARATION_EXPIRED",
  "DEBUG_CONFIGURATION_ALREADY_EXISTS",
  "DEBUG_CONFIGURATION_CHANGED",
  "DEBUG_SESSION_NOT_FOUND",
  "DEBUG_START_FAILED",
  "DEBUG_REQUEST_UNSUPPORTED",
  "DEBUG_REQUEST_FAILED",
  "DEBUG_STATE_STALE",
  "BREAKPOINT_OUT_OF_SCOPE",
  "EXPERIMENT_STATE_CHANGED",
  "EDITOR_REVEAL_FAILED",
  "EXTENSION_NOT_FOUND",
  "OUTPUT_SOURCE_NOT_FOUND",
  "OUTPUT_NOT_VISIBLE",
  "OUTPUT_UNAVAILABLE",
  "OUTPUT_CURSOR_EXPIRED",
  "DEBUG_OUTPUT_UNAVAILABLE",
  "PROFILE_CONTEXT_UNAVAILABLE",
  "MARKETPLACE_UNAVAILABLE",
  "EXTENSION_CANDIDATE_NOT_FOUND",
  "EXTENSION_CANDIDATE_EXPIRED",
  "EXTENSION_INSTALL_UNSUPPORTED",
  "EXTENSION_INSTALL_FAILED",
  "EXTENSION_CONFIGURATION_DENIED",
  "EXTENSION_CONFIGURATION_STALE",
  "EXTENSION_INTEGRATION_NOT_FOUND",
  "EXTENSION_VERSION_UNSUPPORTED",
  "EXTENSION_ACTIVATION_FAILED",
  "EXTENSION_INTEGRATION_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];
export type BridgeMethod = (typeof BRIDGE_METHODS)[keyof typeof BRIDGE_METHODS];
