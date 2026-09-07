import { randomUUID } from "node:crypto";
import { updateManagedConfigText, removeManagedConfigText, type CodexConfigChangeResult, type ServiceIdentity } from "@vscode-agent-bridge/protocol";
import { readOptional, writePrivateAtomic } from "./service-state.js";
import { ServiceError } from "./service-errors.js";

export function httpConnection(identity: ServiceIdentity) {
  return { url: `http://127.0.0.1:${identity.port}/mcp`, token: identity.mcpToken };
}

export async function writeConfigChange(configPath: string, source: string | null, result: string, sid: string): Promise<CodexConfigChangeResult> {
  if (await readOptional(configPath) !== source) throw new ServiceError("SERVICE_INSTALL_CONFLICT", "Codex configuration changed during the operation; retry after reviewing it.");
  if (source === result || (source === null && result === "")) return { changed: false };
  const backupPath = source !== null ? `${configPath}.backup-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}` : undefined;
  if (backupPath) await writePrivateAtomic(backupPath, source!, sid);
  // Detect concurrent edits again after the backup, before the atomic replacement.
  if (await readOptional(configPath) !== source) throw new ServiceError("SERVICE_INSTALL_CONFLICT", "Codex configuration changed during the operation; retry after reviewing it.");
  await writePrivateAtomic(configPath, result, sid);
  return { changed: true, ...(backupPath ? { backupPath } : {}) };
}

export async function updateCodexConfigFile(configPath: string, identity: ServiceIdentity): Promise<CodexConfigChangeResult> {
  const source = await readOptional(configPath);
  return writeConfigChange(configPath, source, updateManagedConfigText(source ?? "", httpConnection(identity)), identity.userSid);
}

export async function removeCodexConfigBlock(configPath: string, sid: string): Promise<CodexConfigChangeResult> {
  const source = await readOptional(configPath);
  return writeConfigChange(configPath, source, removeManagedConfigText(source ?? ""), sid);
}
