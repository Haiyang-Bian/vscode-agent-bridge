import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_RELEASE_VERSION, SERVICE_ERROR_CODES, ServiceStatusSchema, type CodexConfigChangeResult, type CodexConfigStatus } from "@vscode-agent-bridge/protocol";
import { CodexConfigConflictError } from "./codex-config.js";

const EXECUTABLE_NAME = "vscode-agent-bridge-mcp.exe";
const execFileAsync = promisify(execFile);
export interface InstallationResult extends CodexConfigChangeResult { readonly executableInstalled: boolean; }
export interface InstallationDoctorResult {
  readonly releaseVersion: string;
  readonly extensionVersion: string;
  readonly protocolVersion: number;
  readonly versionAligned: boolean;
  readonly platformSupported: boolean;
  readonly bundledExecutable: "present" | "missing" | "invalid";
  readonly installedExecutable: "present" | "missing" | "invalid";
  readonly codexConfig: CodexConfigStatus;
  readonly httpService: "ready" | "starting" | "stopping" | "unavailable" | "authentication-error";
  readonly loginTask: "present" | "missing" | "invalid";
  readonly serviceVersion: string | null;
  readonly servicePid: number | null;
}

export async function configureCodexIntegration(context: vscode.ExtensionContext): Promise<InstallationResult> {
  const result = await runServiceCommand(context, ["service", "install", "--config", resolveCodexConfigPath()]);
  ServiceStatusSchema.parse(result.status);
  return { changed: result.changed === true, executableInstalled: result.executableInstalled === true,
    ...(typeof result.backupPath === "string" ? { backupPath: result.backupPath } : {}) };
}

export async function removeCodexIntegration(context: vscode.ExtensionContext): Promise<CodexConfigChangeResult> {
  const result = await runServiceCommand(context, ["service", "uninstall"]);
  return { changed: result.changed === true, ...(typeof result.backupPath === "string" ? { backupPath: result.backupPath } : {}) };
}

export async function inspectInstallation(context: vscode.ExtensionContext): Promise<InstallationDoctorResult> {
  const bundledExecutable = await validateExecutableWithSidecar(resolveBundledExecutablePath(context));
  const report: InstallationDoctorResult = {
    releaseVersion: BRIDGE_RELEASE_VERSION, extensionVersion: String(context.extension.packageJSON.version ?? "unknown"),
    protocolVersion: BRIDGE_PROTOCOL_VERSION, versionAligned: context.extension.packageJSON.version === BRIDGE_RELEASE_VERSION,
    platformSupported: process.platform === "win32" && process.arch === "x64", bundledExecutable,
    installedExecutable: "missing", codexConfig: "missing", httpService: "unavailable", loginTask: "missing", serviceVersion: null, servicePid: null,
  };
  if (bundledExecutable !== "present" || !report.platformSupported) return report;
  try {
    const status = await runServiceCommand(context, ["service", "status", "--config", resolveCodexConfigPath()]);
    const service = ServiceStatusSchema.safeParse(status.service);
    const codexConfig = ["missing", "current", "outdated", "conflict", "invalid"].includes(String(status.codexConfig)) ? status.codexConfig as CodexConfigStatus : "invalid";
    return { ...report, installedExecutable: status.installed ? (status.installedVersion === BRIDGE_RELEASE_VERSION && status.installedExecutable === "present" ? "present" : "invalid") : "missing",
      codexConfig, loginTask: status.loginTask === "present" ? "present" : status.loginTask === "missing" ? "missing" : "invalid",
      httpService: status.serviceError === "SERVICE_AUTHENTICATION_FAILED" ? "authentication-error" : service.success ? service.data.state : "unavailable",
      serviceVersion: service.success ? service.data.version : null, servicePid: service.success ? service.data.pid : null };
  } catch { return { ...report, installedExecutable: "invalid", codexConfig: "invalid" }; }
}

export function resolveCodexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
}
function resolveBundledExecutablePath(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join("resources", "bin", EXECUTABLE_NAME));
}
async function runServiceCommand(context: vscode.ExtensionContext, args: string[]): Promise<Record<string, unknown>> {
  const executable = resolveBundledExecutablePath(context);
  if (await validateExecutableWithSidecar(executable) !== "present") throw new Error("The packaged MCP executable is missing or failed its SHA-256 validation. Reinstall the extension.");
  try {
    const { stdout } = await execFileAsync(executable, args, { encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 128 * 1024 });
    return JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch (error) {
    // Do not forward child_process errors: they contain arguments and raw output.
    let code: string | undefined;
    try {
      const stderr = (error as { stderr?: string }).stderr;
      const candidate: unknown = JSON.parse(stderr ?? "{}").error?.code;
      if (typeof candidate === "string" && (SERVICE_ERROR_CODES as readonly string[]).includes(candidate)) code = candidate;
    } catch { /* Redacted generic error below. */ }
    if (code === "SERVICE_INSTALL_CONFLICT") throw new CodexConfigConflictError("Review the existing Codex configuration or wait for the current installation to finish.");
    throw new Error(`The HTTP service operation failed${code ? ` (${code})` : ""}. Run Bridge Doctor or the local service status command.`);
  }
}
async function validateExecutableWithSidecar(executablePath: string): Promise<"present" | "missing" | "invalid"> {
  try {
    const expected = (await readFile(`${executablePath}.sha256`, "utf8")).trim().toLowerCase();
    return createHash("sha256").update(await readFile(executablePath)).digest("hex") === expected ? "present" : "invalid";
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid"; }
}
