export const MCP_TOOL_DOMAINS = {
  context: "Instance and workspace context",
  language: "Language intelligence",
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
  readonly recoverability: McpToolRecoverability;
  readonly openWorld: boolean;
  readonly sensitivity: McpToolSensitivity;
  readonly annotations: McpToolAnnotations;
}

const READ_ONLY = annotations(true, false, true, false);
const READ_ONLY_OPEN_WORLD = annotations(true, false, true, true);
const READ_ONLY_ACTIVATING = annotations(true, false, false, true);
const PREPARE = annotations(true, false, false, false);
const STATEFUL_PREPARE = annotations(false, false, false, false);
const PREPARE_OPEN_WORLD = annotations(true, false, false, true);
const GUARDED_WRITE = annotations(false, false, false, false);
const DESTRUCTIVE_LOCAL_WRITE = annotations(false, true, false, false);
const OPEN_WORLD_WRITE = annotations(false, true, false, true);

export const MCP_TOOL_CATALOG = [
  entry("vscode_list_instances", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_editor_context", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_workspace_setup", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_workspace_configuration", "context", "observe", "none", "notApplicable", "source", READ_ONLY),
  entry("vscode_get_bridge_capabilities", "context", "observe", "none", "notApplicable", "public", READ_ONLY),
  entry("vscode_get_usage_insights", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_list_extensions", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_extension_details", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_extension_configuration_schema", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_profile_context", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_list_output_sources", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_read_visible_output", "context", "observe", "none", "notApplicable", "source", READ_ONLY),
  entry("vscode_search_extensions", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY_OPEN_WORLD),
  entry("vscode_prepare_extension_install", "context", "prepare", "memory", "notApplicable", "workspaceMetadata", PREPARE_OPEN_WORLD),
  entry("vscode_apply_extension_install", "context", "act", "process", "none", "workspaceMetadata", OPEN_WORLD_WRITE),
  entry("vscode_get_extension_configuration", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_list_extension_integrations", "context", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_get_extension_integration_state", "context", "observe", "process", "none", "workspaceMetadata", READ_ONLY_ACTIVATING),

  entry("vscode_get_diagnostics", "language", "observe", "none", "notApplicable", "source", READ_ONLY),
  entry("vscode_get_document_symbols", "language", "observe", "none", "notApplicable", "source", READ_ONLY_ACTIVATING),
  entry("vscode_get_definitions", "language", "observe", "none", "notApplicable", "source", READ_ONLY_ACTIVATING),
  entry("vscode_get_references", "language", "observe", "none", "notApplicable", "source", READ_ONLY_ACTIVATING),
  entry("vscode_get_hover", "language", "observe", "none", "notApplicable", "source", READ_ONLY_ACTIVATING),
  entry("vscode_list_diagnostic_events", "language", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),


  entry("vscode_update_workspace_configuration", "editing", "act", "workspace", "partial", "source", OPEN_WORLD_WRITE),
  entry("vscode_read_document", "editing", "observe", "none", "notApplicable", "source", READ_ONLY),
  entry("vscode_prepare_text_edits", "editing", "prepare", "memory", "notApplicable", "source", PREPARE),
  entry("vscode_prepare_rename", "editing", "prepare", "memory", "notApplicable", "source", PREPARE),
  entry("vscode_prepare_resource_changes", "editing", "prepare", "memory", "notApplicable", "source", PREPARE),
  entry("vscode_apply_change_set", "editing", "act", "workspace", "none", "source", DESTRUCTIVE_LOCAL_WRITE),
  entry("vscode_save_document", "editing", "act", "workspace", "none", "source", GUARDED_WRITE),
  entry("vscode_format_document", "editing", "act", "workspace", "none", "source", GUARDED_WRITE),
  entry("vscode_list_code_actions", "editing", "prepare", "memory", "notApplicable", "source", PREPARE),
  entry("vscode_apply_code_action", "editing", "act", "workspace", "none", "source", GUARDED_WRITE),
  entry("vscode_update_extension_configuration", "editing", "act", "process", "partial", "workspaceMetadata", OPEN_WORLD_WRITE),

  entry("vscode_list_terminals", "terminals", "observe", "none", "notApplicable", "terminal", READ_ONLY),
  entry("vscode_list_terminal_executions", "terminals", "observe", "none", "notApplicable", "terminal", READ_ONLY),
  entry("vscode_read_terminal_output", "terminals", "observe", "none", "notApplicable", "terminal", READ_ONLY),

  entry("vscode_list_tasks", "tasks", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_prepare_task", "tasks", "prepare", "memory", "notApplicable", "terminal", STATEFUL_PREPARE),
  entry("vscode_persist_task", "tasks", "act", "workspace", "partial", "terminal", OPEN_WORLD_WRITE),
  entry("vscode_run_task", "tasks", "control", "process", "none", "terminal", OPEN_WORLD_WRITE),
  entry("vscode_list_task_executions", "tasks", "observe", "none", "notApplicable", "terminal", READ_ONLY),
  entry("vscode_terminate_task", "tasks", "control", "process", "none", "terminal", OPEN_WORLD_WRITE),

  entry("vscode_list_debug_configurations", "debug", "observe", "none", "notApplicable", "workspaceMetadata", READ_ONLY),
  entry("vscode_prepare_debug_configuration", "debug", "prepare", "memory", "notApplicable", "debug", STATEFUL_PREPARE),
  entry("vscode_persist_debug_configuration", "debug", "act", "workspace", "partial", "debug", OPEN_WORLD_WRITE),
  entry("vscode_start_debug_session", "debug", "control", "debuggee", "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_list_debug_sessions", "debug", "observe", "none", "notApplicable", "debug", READ_ONLY),
  entry("vscode_get_debug_state", "debug", "observe", "none", "notApplicable", "debug", READ_ONLY),
  entry("vscode_control_debug_session", "debug", "control", "debuggee", "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_list_breakpoints", "debug", "observe", "none", "notApplicable", "debug", READ_ONLY),
  entry("vscode_update_breakpoints", "debug", "act", "debuggee", "partial", "debug", GUARDED_WRITE),
  entry("vscode_evaluate_debug_expression", "debug", "control", "debuggee", "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_set_debug_variable", "debug", "control", "debuggee", "none", "debug", OPEN_WORLD_WRITE),
  entry("vscode_list_debug_output", "debug", "observe", "none", "notApplicable", "debug", READ_ONLY),
  entry("vscode_read_debug_output", "debug", "observe", "none", "notApplicable", "debug", READ_ONLY),
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
  recoverability: McpToolRecoverability,
  sensitivity: McpToolSensitivity,
  toolAnnotations: McpToolAnnotations,
): McpToolCatalogEntry {
  return {
    name,
    domain,
    intent,
    sideEffectScope,
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
