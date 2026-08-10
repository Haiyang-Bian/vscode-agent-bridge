export const MCP_TOOL_DOMAINS = {
  context: "Instance and workspace context",
  language: "Language intelligence",
  experiments: "Experiments and history",
  editing: "Editing, configuration and resources",
  terminals: "Terminals",
  tasks: "Tasks",
  debug: "Debug",
} as const;

export type McpToolDomain = keyof typeof MCP_TOOL_DOMAINS;
export type McpToolIntent = "observe" | "prepare" | "act" | "control";
export type McpToolRecoverability = "full" | "partial" | "none" | "notApplicable";
export type McpToolSensitivity =
  | "public"
  | "workspaceMetadata"
  | "source"
  | "terminal"
  | "debug";

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolCatalogEntry {
  readonly name: string;
  readonly domain: McpToolDomain;
  readonly intent: McpToolIntent;
  readonly sideEffectScope: "none" | "memory" | "workspace" | "process" | "debuggee";
  readonly requiresExperiment: boolean;
  readonly recoverability: McpToolRecoverability;
  readonly openWorld: boolean;
  readonly sensitivity: McpToolSensitivity;
  readonly annotations: McpToolAnnotations;
}

const READ_ONLY = annotations(true, false, true, false);
const PREPARE = annotations(true, false, false, false);
const GUARDED_WRITE = annotations(false, false, false, false);
const DESTRUCTIVE_LOCAL_WRITE = annotations(false, true, false, false);
const OPEN_WORLD_WRITE = annotations(false, true, false, true);

export const MCP_TOOL_CATALOG = [
  entry("vscode_list_instances", "context", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_editor_context", "context", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_workspace_setup", "context", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_workspace_configuration", "context", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_get_bridge_capabilities", "context", "observe", "none", false, "notApplicable", "public", READ_ONLY),
  entry("vscode_get_usage_insights", "context", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),

  entry("vscode_get_diagnostics", "language", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_get_document_symbols", "language", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_get_definitions", "language", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_get_references", "language", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_get_hover", "language", "observe", "none", false, "notApplicable", "source", READ_ONLY),

  entry("vscode_get_experiment", "experiments", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_list_experiments", "experiments", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_start_experiment", "experiments", "act", "workspace", false, "full", "workspaceMetadata", GUARDED_WRITE),
  entry("vscode_rename_experiment", "experiments", "act", "workspace", true, "full", "workspaceMetadata", GUARDED_WRITE),
  entry("vscode_create_experiment_checkpoint", "experiments", "act", "workspace", true, "full", "workspaceMetadata", GUARDED_WRITE),
  entry("vscode_list_experiment_checkpoints", "experiments", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_record_experiment_evidence", "experiments", "act", "workspace", true, "full", "workspaceMetadata", GUARDED_WRITE),

  entry("vscode_update_workspace_configuration", "editing", "act", "workspace", true, "full", "source", GUARDED_WRITE),
  entry("vscode_read_document", "editing", "observe", "none", false, "notApplicable", "source", READ_ONLY),
  entry("vscode_prepare_text_edits", "editing", "prepare", "memory", true, "notApplicable", "source", PREPARE),
  entry("vscode_prepare_rename", "editing", "prepare", "memory", true, "notApplicable", "source", PREPARE),
  entry("vscode_prepare_resource_changes", "editing", "prepare", "memory", true, "notApplicable", "source", PREPARE),
  entry("vscode_apply_change_set", "editing", "act", "workspace", true, "full", "source", DESTRUCTIVE_LOCAL_WRITE),
  entry("vscode_save_document", "editing", "act", "workspace", true, "full", "source", GUARDED_WRITE),
  entry("vscode_format_document", "editing", "act", "workspace", true, "full", "source", GUARDED_WRITE),
  entry("vscode_list_code_actions", "editing", "prepare", "memory", true, "notApplicable", "source", PREPARE),
  entry("vscode_apply_code_action", "editing", "act", "workspace", true, "full", "source", GUARDED_WRITE),

  entry("vscode_list_terminals", "terminals", "observe", "none", false, "notApplicable", "terminal", READ_ONLY),
  entry("vscode_list_terminal_executions", "terminals", "observe", "none", false, "notApplicable", "terminal", READ_ONLY),
  entry("vscode_read_terminal_output", "terminals", "observe", "none", false, "notApplicable", "terminal", READ_ONLY),

  entry("vscode_list_tasks", "tasks", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_run_task", "tasks", "control", "process", true, "partial", "terminal", OPEN_WORLD_WRITE),
  entry("vscode_list_task_executions", "tasks", "observe", "none", false, "notApplicable", "terminal", READ_ONLY),
  entry("vscode_terminate_task", "tasks", "control", "process", true, "none", "terminal", OPEN_WORLD_WRITE),

  entry("vscode_list_debug_configurations", "debug", "observe", "none", false, "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_start_debug_session", "debug", "control", "process", true, "partial", "debug", OPEN_WORLD_WRITE),
  entry("vscode_list_debug_sessions", "debug", "observe", "none", false, "notApplicable", "debug", READ_ONLY),
  entry("vscode_get_debug_state", "debug", "observe", "none", false, "notApplicable", "debug", READ_ONLY),
  entry("vscode_control_debug_session", "debug", "control", "debuggee", true, "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_list_breakpoints", "debug", "observe", "none", false, "notApplicable", "debug", READ_ONLY),
  entry("vscode_update_breakpoints", "debug", "act", "debuggee", true, "partial", "debug", GUARDED_WRITE),
  entry("vscode_evaluate_debug_expression", "debug", "control", "debuggee", true, "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_set_debug_variable", "debug", "control", "debuggee", true, "none", "debug", OPEN_WORLD_WRITE),
] as const satisfies readonly McpToolCatalogEntry[];

export type McpToolName = (typeof MCP_TOOL_CATALOG)[number]["name"];
export const MCP_TOOL_NAMES = MCP_TOOL_CATALOG.map((tool) => tool.name) as readonly McpToolName[];

export function getMcpToolCatalogEntry(name: string): McpToolCatalogEntry | undefined {
  return MCP_TOOL_CATALOG.find((tool) => tool.name === name);
}

function entry(
  name: string,
  domain: McpToolDomain,
  intent: McpToolIntent,
  sideEffectScope: McpToolCatalogEntry["sideEffectScope"],
  requiresExperiment: boolean,
  recoverability: McpToolRecoverability,
  sensitivity: McpToolSensitivity,
  toolAnnotations: McpToolAnnotations,
): McpToolCatalogEntry {
  return {
    name,
    domain,
    intent,
    sideEffectScope,
    requiresExperiment,
    recoverability,
    openWorld: toolAnnotations.openWorldHint,
    sensitivity,
    annotations: toolAnnotations,
  };
}

function annotations(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): McpToolAnnotations {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}
