import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type * as vscode from "vscode";

import { BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

import {
  inspectCodexConfigFile,
  removeCodexConfigBlock,
  updateCodexConfigFile,
  type CodexConfigChangeResult,
  type CodexConfigStatus,
  type AgentPolicyOptions,
  DEFAULT_AGENT_POLICIES,
} from "./codex-config.js";

const EXECUTABLE_NAME = "vscode-agent-bridge-mcp.exe";
const execFileAsync = promisify(execFile);

export interface InstallationResult extends CodexConfigChangeResult {
  readonly executableInstalled: boolean;
}

export interface InstallationDoctorResult {
  readonly releaseVersion: string;
  readonly extensionVersion: string;
  readonly protocolVersion: number;
  readonly versionAligned: boolean;
  readonly platformSupported: boolean;
  readonly bundledExecutable: "present" | "missing" | "invalid";
  readonly installedExecutable: "present" | "missing" | "invalid";
  readonly codexConfig: CodexConfigStatus;
}

export async function configureCodexIntegration(
  context: vscode.ExtensionContext,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): Promise<InstallationResult> {
  const installation = await installBundledExecutable(context);
  const configResult = await updateCodexConfigFile(
    resolveCodexConfigPath(),
    installation.executablePath,
    policies,
  );
  return {
    ...configResult,
    executableInstalled: installation.changed,
  };
}

export async function removeCodexIntegration(): Promise<CodexConfigChangeResult> {
  return removeCodexConfigBlock(resolveCodexConfigPath());
}

export async function inspectInstallation(
  context: vscode.ExtensionContext,
  policies: AgentPolicyOptions = DEFAULT_AGENT_POLICIES,
): Promise<InstallationDoctorResult> {
  const bundledExecutable = await validateExecutableWithSidecar(
    resolveBundledExecutablePath(context),
  );
  const installedExecutablePath = resolveInstalledExecutablePath();
  const installedExecutable = await validateInstalledExecutable(installedExecutablePath);
  const codexConfig = await inspectCodexConfigFile(
    resolveCodexConfigPath(),
    installedExecutablePath,
    policies,
  );

  return {
    releaseVersion: BRIDGE_RELEASE_VERSION,
    extensionVersion: String(context.extension.packageJSON.version ?? "unknown"),
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    versionAligned: context.extension.packageJSON.version === BRIDGE_RELEASE_VERSION,
    platformSupported: process.platform === "win32" && process.arch === "x64",
    bundledExecutable,
    installedExecutable,
    codexConfig,
  };
}

export function resolveCodexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function resolveInstalledExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const localAppData = env.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
  return path.join(
    localAppData,
    "VSCodeAgentBridge",
    "versions",
    BRIDGE_RELEASE_VERSION,
    EXECUTABLE_NAME,
  );
}

function resolveBundledExecutablePath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join("resources", "bin", EXECUTABLE_NAME));
}

async function installBundledExecutable(
  context: vscode.ExtensionContext,
): Promise<{ executablePath: string; changed: boolean }> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This release only includes a Windows x64 MCP executable.");
  }

  const sourcePath = resolveBundledExecutablePath(context);
  const sourceStatus = await validateExecutableWithSidecar(sourcePath);
  if (sourceStatus !== "present") {
    throw new Error(
      sourceStatus === "missing"
        ? "The packaged MCP executable is missing. Reinstall the extension from Marketplace."
        : "The packaged MCP executable failed its SHA-256 validation.",
    );
  }

  const expectedHash = (await readFile(`${sourcePath}.sha256`, "utf8")).trim().toLowerCase();
  const targetPath = resolveInstalledExecutablePath();
  if ((await validateHash(targetPath, expectedHash)) === "present") {
    return { executablePath: targetPath, changed: false };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await copyFile(sourcePath, temporaryPath);
    await assertExpectedHash(temporaryPath, expectedHash);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    throw new Error(
      "Could not install the MCP executable. Restart Codex to release the previous executable and retry.",
      { cause: error },
    );
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  return { executablePath: targetPath, changed: true };
}

async function assertExpectedHash(filePath: string, expectedHash: string): Promise<void> {
  if ((await validateHash(filePath, expectedHash)) !== "present") {
    throw new Error("The copied MCP executable failed its SHA-256 validation.");
  }
}

async function validateExecutableWithSidecar(
  executablePath: string,
): Promise<"present" | "missing" | "invalid"> {
  try {
    const expectedHash = (await readFile(`${executablePath}.sha256`, "utf8"))
      .trim()
      .toLowerCase();
    return validateHash(executablePath, expectedHash);
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "invalid";
  }
}

async function validateInstalledExecutable(
  executablePath: string,
): Promise<"present" | "missing" | "invalid"> {
  try {
    await access(executablePath);
    const { stdout } = await execFileAsync(executablePath, ["--self-test"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return result.version === BRIDGE_RELEASE_VERSION &&
      result.protocolVersion === BRIDGE_PROTOCOL_VERSION &&
      result.platform === "win32" &&
      result.architecture === "x64"
      ? "present"
      : "invalid";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "invalid";
  }
}

async function validateHash(
  filePath: string,
  expectedHash: string,
): Promise<"present" | "missing" | "invalid"> {
  try {
    return (await sha256File(filePath)) === expectedHash ? "present" : "invalid";
  } catch (error) {
    return isMissingFileError(error) ? "missing" : "invalid";
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
