import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

import {
  MCP_TOOL_NAMES,
  type AutonomyProfile,
  type TerminalReadPolicy,
} from "@vscode-agent-bridge/protocol";

export const MANAGED_BLOCK_START = "# vscode-agent-bridge:begin";
export const MANAGED_BLOCK_END = "# vscode-agent-bridge:end";

export type CodexConfigStatus = "missing" | "current" | "outdated" | "conflict" | "invalid";

export interface CodexConfigChangeResult {
  readonly changed: boolean;
  readonly backupPath?: string;
}

export interface AgentPolicyOptions {
  readonly autonomyProfile: AutonomyProfile;
  readonly terminalReadPolicy: TerminalReadPolicy;
}

export const DEFAULT_AGENT_POLICIES: AgentPolicyOptions = {
  autonomyProfile: "autonomous",
  terminalReadPolicy: "allow",
};

export class CodexConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigConflictError";
  }
}

export function createManagedConfigBlock(
  executablePath: string,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): string {
  const command = JSON.stringify(normalizeCommandPath(executablePath));
  const enabledTools = enabledToolsForPolicies(policies)
    .map((name) => `  ${JSON.stringify(name)},`)
    .join("\n");
  const approvalMode = policies.autonomyProfile === "autonomous" ? "approve" : "writes";
  return `${MANAGED_BLOCK_START}
[mcp_servers.vscode_agent_bridge]
command = ${command}
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "${approvalMode}"
enabled_tools = [
${enabledTools}
]
${MANAGED_BLOCK_END}`;
}

export function updateManagedConfigText(
  source: string,
  executablePath: string,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): string {
  validateToml(source);
  const markerRange = findManagedMarkerRange(source);
  const block = createManagedConfigBlock(executablePath, policies);

  let result: string;
  if (markerRange) {
    result = `${source.slice(0, markerRange.start)}${block}${source.slice(markerRange.end)}`;
  } else {
    if (containsUnmanagedBridgeTable(source)) {
      throw new CodexConfigConflictError(
        "A non-managed mcp_servers.vscode_agent_bridge table already exists.",
      );
    }
    const prefix = source.length === 0 ? "" : source.endsWith("\n") ? source : `${source}\n`;
    result = `${prefix}${prefix.length === 0 ? "" : "\n"}${block}\n`;
  }

  validateToml(result);
  return result;
}

export function removeManagedConfigText(source: string): string {
  validateToml(source);
  const markerRange = findManagedMarkerRange(source);
  if (!markerRange) {
    return source;
  }

  let before = source.slice(0, markerRange.start);
  let after = source.slice(markerRange.end);
  if (before.endsWith("\n\n") && after.startsWith("\n")) {
    after = after.slice(1);
  }
  if (before.length === 0 && after.startsWith("\n")) {
    after = after.slice(1);
  }
  if (after.length === 0) {
    before = before.replace(/\n+$/u, before.length > 0 ? "\n" : "");
  }
  const result = `${before}${after}`;
  validateToml(result);
  return result;
}

export function inspectManagedConfigText(
  source: string,
  expectedExecutablePath: string,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): CodexConfigStatus {
  try {
    validateToml(source);
  } catch {
    return "invalid";
  }

  let markerRange: { start: number; end: number } | undefined;
  try {
    markerRange = findManagedMarkerRange(source);
  } catch {
    return "conflict";
  }
  if (!markerRange) {
    return containsUnmanagedBridgeTable(source) ? "conflict" : "missing";
  }

  const parsed = parse(source) as Record<string, unknown>;
  const bridge = readBridgeTable(parsed);
  if (!bridge) {
    return "outdated";
  }
  const command = readConfiguredCommand(bridge);
  const approvalMode = policies.autonomyProfile === "autonomous" ? "approve" : "writes";
  const expectedTools = enabledToolsForPolicies(policies);
  const configuredTools = Array.isArray(bridge.enabled_tools)
    ? bridge.enabled_tools.filter((value): value is string => typeof value === "string")
    : [];
  return command === normalizeCommandPath(expectedExecutablePath) &&
    bridge.default_tools_approval_mode === approvalMode &&
    configuredTools.length === expectedTools.length &&
    configuredTools.every((value, index) => value === expectedTools[index])
    ? "current"
    : "outdated";
}

export async function updateCodexConfigFile(
  configPath: string,
  executablePath: string,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): Promise<CodexConfigChangeResult> {
  const source = await readOptionalText(configPath);
  const result = updateManagedConfigText(source, executablePath, policies);
  return writeConfigChange(configPath, source, result);
}

export async function removeCodexConfigBlock(
  configPath: string,
): Promise<CodexConfigChangeResult> {
  const source = await readOptionalText(configPath);
  const result = removeManagedConfigText(source);
  return writeConfigChange(configPath, source, result);
}

export async function inspectCodexConfigFile(
  configPath: string,
  expectedExecutablePath: string,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): Promise<CodexConfigStatus> {
  const source = await readOptionalText(configPath);
  return inspectManagedConfigText(source, expectedExecutablePath, policies);
}

function findManagedMarkerRange(source: string): { start: number; end: number } | undefined {
  const startCount = countOccurrences(source, MANAGED_BLOCK_START);
  const endCount = countOccurrences(source, MANAGED_BLOCK_END);
  if (startCount === 0 && endCount === 0) {
    return undefined;
  }
  if (startCount !== 1 || endCount !== 1) {
    throw new CodexConfigConflictError("The managed Codex configuration markers are malformed.");
  }

  const start = source.indexOf(MANAGED_BLOCK_START);
  const endMarker = source.indexOf(MANAGED_BLOCK_END);
  if (endMarker < start) {
    throw new CodexConfigConflictError("The managed Codex configuration markers are reversed.");
  }
  return { start, end: endMarker + MANAGED_BLOCK_END.length };
}

function containsUnmanagedBridgeTable(source: string): boolean {
  return /^\s*\[\s*mcp_servers\s*\.\s*vscode_agent_bridge\s*\]\s*(?:#.*)?$/mu.test(source);
}

function validateToml(source: string): void {
  if (source.trim().length > 0) {
    parse(source);
  }
}

function normalizeCommandPath(executablePath: string): string {
  return path.resolve(executablePath).replaceAll("\\", "/");
}

function readBridgeTable(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const servers = parsed.mcp_servers;
  if (!isRecord(servers)) {
    return undefined;
  }
  const bridge = servers.vscode_agent_bridge;
  if (!isRecord(bridge)) {
    return undefined;
  }
  return bridge;
}

function readConfiguredCommand(bridge: Record<string, unknown>): string | undefined {
  return typeof bridge.command === "string" ? bridge.command.replaceAll("\\", "/") : undefined;
}

export function enabledToolsForPolicies(policies: AgentPolicyOptions): readonly string[] {
  const terminalTools = new Set([
    "vscode_list_terminals",
    "vscode_list_terminal_executions",
    "vscode_read_terminal_output",
  ]);
  const writeWorkflowTools = new Set([
    "vscode_prepare_text_edits",
    "vscode_prepare_rename",
    "vscode_start_experiment",
    "vscode_rename_experiment",
    "vscode_create_experiment_checkpoint",
    "vscode_apply_change_set",
    "vscode_record_experiment_evidence",
    "vscode_save_document",
    "vscode_format_document",
    "vscode_apply_code_action",
  ]);
  return MCP_TOOL_NAMES.filter((name) => {
    if (terminalTools.has(name)) {
      if (policies.terminalReadPolicy === "deny") {
        return false;
      }
      if (policies.autonomyProfile === "readOnly" || policies.terminalReadPolicy === "metadataOnly") {
        return name === "vscode_list_terminals";
      }
      return true;
    }
    return policies.autonomyProfile !== "readOnly" || !writeWorkflowTools.has(name);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function countOccurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return "";
    }
    throw error;
  }
}

async function writeConfigChange(
  configPath: string,
  source: string,
  result: string,
): Promise<CodexConfigChangeResult> {
  if (source === result) {
    return { changed: false };
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const backupPath = source.length > 0 ? `${configPath}.backup-${timestamp}` : undefined;
  if (backupPath) {
    await copyFile(configPath, backupPath);
  }

  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, result, "utf8");
    validateToml(await readFile(temporaryPath, "utf8"));
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { changed: true, ...(backupPath ? { backupPath } : {}) };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
