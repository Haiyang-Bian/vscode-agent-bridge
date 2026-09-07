import { parse } from "smol-toml";
import { MCP_TOOL_NAMES } from "./tool-catalog.js";

export interface CodexHttpConnection { readonly url: string; readonly token: string; }

export const MANAGED_BLOCK_START = "# vscode-agent-bridge:begin";
export const MANAGED_BLOCK_END = "# vscode-agent-bridge:end";

export type CodexConfigStatus = "missing" | "current" | "outdated" | "conflict" | "invalid";

export interface CodexConfigChangeResult {
  readonly changed: boolean;
  readonly backupPath?: string;
}

export class CodexConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigConflictError";
  }
}

export function createManagedConfigBlock(
  connection: CodexHttpConnection,
): string {
  assertConnection(connection);
  const enabledTools = MCP_TOOL_NAMES
    .map((name) => `  ${JSON.stringify(name)},`)
    .join("\n");
  return `${MANAGED_BLOCK_START}
[mcp_servers.vscode_agent_bridge]
url = ${JSON.stringify(connection.url)}
http_headers = { Authorization = ${JSON.stringify(`Bearer ${connection.token}`)} }
startup_timeout_sec = 10
tool_timeout_sec = 120
enabled_tools = [
${enabledTools}
]
${MANAGED_BLOCK_END}`;
}

export function updateManagedConfigText(
  source: string,
  connection: CodexHttpConnection,
): string {
  validateToml(source);
  const markerRange = findManagedMarkerRange(source);
  const block = createManagedConfigBlock(connection);

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
  connection: CodexHttpConnection,
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
  const headers = isRecord(bridge.http_headers) ? bridge.http_headers : {};
  const expectedTools = MCP_TOOL_NAMES;
  const configuredTools = Array.isArray(bridge.enabled_tools)
    ? bridge.enabled_tools.filter((value): value is string => typeof value === "string")
    : [];
  return bridge.url === connection.url && headers.Authorization === `Bearer ${connection.token}` &&
    !Object.hasOwn(bridge, "command") && !Object.hasOwn(bridge, "args") &&
    bridge.startup_timeout_sec === 10 && bridge.tool_timeout_sec === 120 &&
    !Object.hasOwn(bridge, "default_tools_approval_mode") &&
    configuredTools.length === expectedTools.length &&
    configuredTools.every((value, index) => value === expectedTools[index])
    ? "current"
    : "outdated";
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
  return readBridgeTable(parse(source) as Record<string, unknown>) !== undefined;
}

function validateToml(source: string): void {
  if (source.trim().length > 0) {
    parse(source);
  }
}

function assertConnection(connection: CodexHttpConnection): void {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp$/u.test(connection.url) || !/^[a-f0-9]{64}$/u.test(connection.token)) {
    throw new Error("Invalid local HTTP service connection.");
  }
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


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function countOccurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}
