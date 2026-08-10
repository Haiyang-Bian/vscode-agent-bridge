import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BRIDGE_PROTOCOL_VERSION, MCP_TOOL_NAMES } from "@vscode-agent-bridge/protocol";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const registryDirectory = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-e2e-"));
const workspaceDirectory = path.join(registryDirectory, "workspace");
const e2eExtensionDirectory = path.join(registryDirectory, "extension");

try {
  await prepareWorkspace(workspaceDirectory);
  await run(["bun", "run", "build"], repositoryRoot);
  await run(["bun", "run", "build:test:e2e"], extensionRoot);
  await stageE2EExtension(e2eExtensionDirectory);
  await run(
    ["node", path.join(repositoryRoot, "node_modules", "@vscode", "test-cli", "out", "bin.mjs")],
    extensionRoot,
    {
      ...process.env,
      VSCODE_AGENT_BRIDGE_REGISTRY_DIR: registryDirectory,
      VSCODE_AGENT_BRIDGE_E2E: "1",
      VSCODE_AGENT_BRIDGE_E2E_INITIALIZATION_DELAY_MS: "10000",
      VSCODE_AGENT_BRIDGE_E2E_ONBOARDING_DELAY_MS: "11000",
      VSCODE_AGENT_BRIDGE_E2E_WORKSPACE: workspaceDirectory,
      VSCODE_AGENT_BRIDGE_E2E_EXTENSION: e2eExtensionDirectory,
      VSCODE_AGENT_BRIDGE_E2E_DEBUG_SOURCE: path.join(workspaceDirectory, "bridge.ts"),
      VSCODE_AGENT_BRIDGE_MANAGED_ROOT: path.join(registryDirectory, "managed-worktrees"),
    },
  );
  await assertPrimaryE2EMarker(registryDirectory);
  await assertManagedE2EMarker(registryDirectory);
} finally {
  await rm(registryDirectory, { recursive: true, force: true });
}

async function assertPrimaryE2EMarker(registryDirectory: string): Promise<void> {
  const marker = JSON.parse(
    await readFile(path.join(registryDirectory, "primary-e2e-passed.json"), "utf8"),
  ) as Record<string, unknown>;
  if (marker.protocolVersion !== BRIDGE_PROTOCOL_VERSION || marker.toolCount !== MCP_TOOL_NAMES.length) {
    throw new Error("Primary IDE workflow E2E completion marker is invalid.");
  }
}

async function stageE2EExtension(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(path.join(extensionRoot, "dist"), path.join(target, "dist"), { recursive: true });
  await cp(path.join(extensionRoot, "resources"), path.join(target, "resources"), { recursive: true });
  await cp(path.join(extensionRoot, "package.json"), path.join(target, "package.json"));
}

async function assertManagedE2EMarker(registryDirectory: string): Promise<void> {
  const marker = JSON.parse(
    await readFile(path.join(registryDirectory, "managed-e2e-passed.json"), "utf8"),
  ) as Record<string, unknown>;
  if (marker.privateCommitCount !== 10 || marker.promotedCommitCount !== 1 || marker.treeMatches !== true) {
    throw new Error("Managed worktree E2E completion marker is invalid.");
  }
}

async function prepareWorkspace(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(path.join(extensionRoot, "test", "fixtures", "typescript-workspace"), target, {
    recursive: true,
  });
  await rm(path.join(target, ".vscode"), { recursive: true, force: true });
  await run(["git", "init", "--initial-branch=main"], target);
  await run(["git", "config", "user.name", "VS Code Agent Bridge E2E"], target);
  await run(["git", "config", "user.email", "bridge-e2e@example.invalid"], target);
  await run(["git", "add", "."], target);
  await run(["git", "commit", "-m", "fixture baseline"], target);
}

async function run(
  command: string[],
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
    process.exit(exitCode);
  }
}
