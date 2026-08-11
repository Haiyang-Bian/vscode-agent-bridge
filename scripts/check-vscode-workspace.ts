import { readFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

const repositoryRoot = path.resolve(import.meta.dir, "..");
const workspacePath = "vscode-agent-bridge.code-workspace";
const tasksPath = ".vscode/tasks.json";
const launchPath = ".vscode/launch.json";
const settingsPath = ".vscode/settings.json";
const errors: string[] = [];

const workspace = await readJson(workspacePath);
const tasksDocument = await readJson(tasksPath);
const launchDocument = await readJson(launchPath);
await readJson(settingsPath);

const folders = asObjectArray(workspace.folders);
const expectedFolders = new Map([
  ["Repository", "."],
  ["MCP Server", "packages/mcp-server"],
  ["Protocol", "packages/protocol"],
  ["VS Code Extension", "packages/vscode-extension"],
]);
if (folders.length !== expectedFolders.size) {
  errors.push(`The workspace must expose exactly ${expectedFolders.size} curated roots.`);
}
for (const [name, folderPath] of expectedFolders) {
  const folder = folders.find((candidate) => candidate.name === name);
  if (folder?.path !== folderPath) {
    errors.push(`Workspace root ${name} must use path ${folderPath}.`);
  }
}

const workspaceSettings = asObject(workspace.settings);
for (const [key, expected] of Object.entries({
  "task.allowAutomaticTasks": "off",
  "npm.autoDetect": "off",
  "typescript.tsc.autoDetect": "off",
  "debug.javascript.autoAttachFilter": "disabled",
})) {
  if (workspaceSettings[key] !== expected) {
    errors.push(`Workspace setting ${key} must be ${JSON.stringify(expected)}.`);
  }
}
if (workspaceSettings["typescript.tsdk"] !== undefined) {
  errors.push("Do not override the VS Code TypeScript language service with the compiler-only TypeScript 7 package.");
}
for (const packagePath of expectedFolders.values()) {
  if (packagePath === ".") {
    continue;
  }
  if (asObject(workspaceSettings["files.exclude"])[packagePath] !== true) {
    errors.push(`Repository duplicate ${packagePath} must be hidden from the root Explorer view.`);
  }
}

const recommendations = asStringArray(asObject(workspace.extensions).recommendations).map((item) => item.toLowerCase());
for (const extensionId of [
  "oven.bun-vscode",
  "editorconfig.editorconfig",
  "davidanson.vscode-markdownlint",
  "github.vscode-github-actions",
]) {
  if (!recommendations.includes(extensionId)) {
    errors.push(`Missing workspace extension recommendation: ${extensionId}`);
  }
}

const tasks = asObjectArray(tasksDocument.tasks);
const taskLabels = tasks.map((task) => asString(task.label)).filter(Boolean);
assertUnique(taskLabels, "task label");
for (const requiredLabel of [
  "Bridge: Plan affected validation",
  "Bridge: Check affected",
  "Bridge: Build all",
  "Bridge: Test domain...",
  "Bridge: E2E scenario...",
  "Bridge: Full check (high risk / PR)",
]) {
  if (!taskLabels.includes(requiredLabel)) {
    errors.push(`Missing required VS Code task: ${requiredLabel}`);
  }
}
for (const task of tasks) {
  const label = asString(task.label) || "<unlabeled>";
  if (task.type !== "process" || task.command !== "bun") {
    errors.push(`Task ${label} must use the fixed Bun process boundary.`);
  }
  if (asObject(task.runOptions).runOn === "folderOpen") {
    errors.push(`Task ${label} must never run automatically on folder open.`);
  }
  if (asObject(task.options).cwd !== "${workspaceFolder:Repository}") {
    errors.push(`Task ${label} must execute from the named Repository root.`);
  }
}

const configurations = asObjectArray(launchDocument.configurations);
const configurationNames = configurations.map((configuration) => asString(configuration.name)).filter(Boolean);
assertUnique(configurationNames, "debug configuration name");
for (const requiredName of [
  "Bridge: Extension Host",
  "Bridge: Debug active Bun test",
  "Bridge: Debug active Bun file",
]) {
  if (!configurationNames.includes(requiredName)) {
    errors.push(`Missing required debug configuration: ${requiredName}`);
  }
}
for (const configuration of configurations) {
  const name = asString(configuration.name) || "<unnamed>";
  if (!new Set(["extensionHost", "bun"]).has(asString(configuration.type))) {
    errors.push(`Debug configuration ${name} uses an unsupported debugger type.`);
  }
  const preLaunchTask = asString(configuration.preLaunchTask);
  if (preLaunchTask && !taskLabels.includes(preLaunchTask)) {
    errors.push(`Debug configuration ${name} references missing task ${preLaunchTask}.`);
  }
}

const extensionHost = configurations.find((configuration) => configuration.name === "Bridge: Extension Host");
const extensionArgs = asStringArray(extensionHost?.args);
for (const requiredPrefix of ["--extensionDevelopmentPath=", "--user-data-dir=", "--extensions-dir="]) {
  if (!extensionArgs.some((argument) => argument.startsWith(requiredPrefix))) {
    errors.push(`Extension Host debug configuration is missing ${requiredPrefix}.`);
  }
}
if (extensionHost?.preLaunchTask !== "Bridge: Build all") {
  errors.push("Extension Host debugging must build the repository first.");
}

for (const relativePath of [workspacePath, tasksPath, launchPath, settingsPath]) {
  const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  if (/[A-Za-z]:[\\/]Users[\\/]/i.test(contents)) {
    errors.push(`Machine-specific absolute path found in ${relativePath}.`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  throw new Error(`VS Code workspace validation failed with ${errors.length} error(s).`);
}

console.log(
  `VS Code workspace validated (${folders.length} roots, ${tasks.length} tasks, ${configurations.length} debug configurations, ${recommendations.length} recommendations).`,
);

async function readJson(relativePath: string): Promise<JsonObject> {
  const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  try {
    return asObject(JSON.parse(contents));
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertUnique(values: readonly string[], label: string): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  for (const duplicate of new Set(duplicates)) {
    errors.push(`Duplicate ${label}: ${duplicate}`);
  }
}
