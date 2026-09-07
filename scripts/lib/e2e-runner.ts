import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BRIDGE_PROTOCOL_VERSION, MCP_TOOL_NAMES } from "@vscode-agent-bridge/protocol";

import { E2E_SCENARIOS, type E2EScenario } from "./test-impact.ts";

export interface E2EEnvironment {
  root: string;
  workspace: string;
  stagedExtension: string;
  userData: string;
  extensions: string;
  managedWorktrees: string;
}

export interface PrimaryCompletionMarker {
  protocolVersion: number;
  toolCount: number;
  requestedScenarios: string[];
  actualScenarios: string[];
  cleanupStatus: string;
}

export async function createE2EEnvironment(prefix: string, temporaryDirectory = os.tmpdir()): Promise<E2EEnvironment> {
  // Windows runners can expose TEMP through an 8.3 alias. Publish one canonical
  // fixture root to VS Code, Git and the security boundary, including new paths.
  const root = await realpath(await mkdtemp(path.join(temporaryDirectory, prefix)));
  const environment = {
    root,
    workspace: path.join(root, "workspace"),
    stagedExtension: path.join(root, "extension"),
    userData: path.join(root, "user-data"),
    extensions: path.join(root, "extensions"),
    managedWorktrees: path.join(root, "managed-worktrees"),
  };
  await Promise.all([
    mkdir(environment.userData, { recursive: true }),
    mkdir(environment.extensions, { recursive: true }),
    mkdir(environment.managedWorktrees, { recursive: true }),
  ]);
  return environment;
}

export async function prepareFixtureWorkspace(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  await rm(path.join(target, ".vscode"), { recursive: true, force: true });
  await runCommand(["git", "init", "--initial-branch=main"], target);
  await runCommand(["git", "config", "user.name", "VS Code Agent Bridge E2E"], target);
  await runCommand(["git", "config", "user.email", "bridge-e2e@example.invalid"], target);
  await runCommand(["git", "add", "."], target);
  await runCommand(["git", "commit", "-m", "fixture baseline"], target);
}

export async function stageDevelopmentExtension(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
  await cp(path.join(source, "resources"), path.join(target, "resources"), { recursive: true });
  await cp(path.join(source, "package.json"), path.join(target, "package.json"));
}

export async function cleanupE2EEnvironment(environment: E2EEnvironment): Promise<void> {
  await rm(environment.root, { recursive: true, force: true });
  try {
    await stat(environment.root);
    throw new Error(`E2E temporary root still exists after cleanup: ${environment.root}`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

export async function runCommand(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with code ${exitCode}.`);
  }
}

export function parseE2EScenarios(values: readonly string[]): E2EScenario[] {
  const flattened = values.flatMap((value) => value.split(",")).filter(Boolean);
  if (flattened.length === 0 || flattened.includes("full")) {
    if (flattened.length > 1) {
      throw new Error("The full E2E scenario cannot be combined with individual scenarios.");
    }
    return [...E2E_SCENARIOS];
  }
  const scenarios: E2EScenario[] = [];
  for (const value of flattened) {
    if (!E2E_SCENARIOS.includes(value as E2EScenario)) {
      throw new Error(`Unknown E2E scenario: ${value}`);
    }
    scenarios.push(value as E2EScenario);
  }
  return [...new Set(scenarios)];
}

export function createE2EEnvironmentVariables(
  environment: E2EEnvironment,
  scenarios: readonly E2EScenario[],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const lifecycle = scenarios.includes("lifecycle");
  return {
    ...process.env,
    ...extra,
    VSCODE_AGENT_BRIDGE_REGISTRY_DIR: environment.root,
    VSCODE_AGENT_BRIDGE_E2E: "1",
    VSCODE_AGENT_BRIDGE_E2E_SCENARIOS: scenarios.join(","),
    VSCODE_AGENT_BRIDGE_E2E_INITIALIZATION_DELAY_MS: lifecycle ? "10000" : "0",
    VSCODE_AGENT_BRIDGE_E2E_ONBOARDING_DELAY_MS: lifecycle ? "11000" : "1",
    VSCODE_AGENT_BRIDGE_E2E_WORKSPACE: environment.workspace,
    VSCODE_AGENT_BRIDGE_E2E_EXTENSION: environment.stagedExtension,
    VSCODE_AGENT_BRIDGE_E2E_DEBUG_SOURCE: path.join(environment.workspace, "bridge.ts"),
    VSCODE_AGENT_BRIDGE_MANAGED_ROOT: environment.managedWorktrees,
    VSCODE_AGENT_BRIDGE_E2E_USER_DATA_DIR: environment.userData,
    VSCODE_AGENT_BRIDGE_E2E_EXTENSIONS_DIR: environment.extensions,
  };
}

export async function assertE2ECompletion(
  environment: E2EEnvironment,
  requestedScenarios: readonly E2EScenario[],
): Promise<void> {
  const primary = JSON.parse(
    await readFile(path.join(environment.root, "primary-e2e-passed.json"), "utf8"),
  ) as PrimaryCompletionMarker;
  if (primary.protocolVersion !== BRIDGE_PROTOCOL_VERSION || primary.toolCount !== MCP_TOOL_NAMES.length) {
    throw new Error("Primary IDE workflow E2E completion marker is invalid.");
  }
  if (primary.cleanupStatus !== "workspace-restored") {
    throw new Error("Primary IDE workflow E2E did not confirm workspace cleanup.");
  }
  if (!sameMembers(primary.requestedScenarios, requestedScenarios)) {
    throw new Error("Primary IDE workflow E2E marker does not match the requested scenarios.");
  }
  for (const scenario of requestedScenarios.filter((candidate) => candidate !== "managed-worktree")) {
    if (!primary.actualScenarios.includes(scenario)) {
      throw new Error(`Primary IDE workflow E2E did not execute ${scenario}.`);
    }
  }

  if (requestedScenarios.includes("managed-worktree")) {
    const managed = JSON.parse(
      await readFile(path.join(environment.root, "managed-e2e-passed.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      managed.privateCommitCount !== 10 ||
      managed.promotedCommitCount !== 1 ||
      managed.treeMatches !== true ||
      managed.scenario !== "managed-worktree" ||
      managed.cleanupStatus !== "client-closed"
    ) {
      throw new Error("Managed Worktree E2E completion marker is invalid.");
    }
  }
}

export async function writeRunnerEvidence(
  target: string,
  value: Record<string, unknown>,
): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
