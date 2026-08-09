import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const registryDirectory = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-e2e-"));
const workspaceDirectory = path.join(registryDirectory, "workspace");

try {
  await prepareWorkspace(workspaceDirectory);
  await run(["bun", "run", "build"], repositoryRoot);
  await run(["bun", "run", "build:test:e2e"], extensionRoot);
  await run(
    ["node", path.join(repositoryRoot, "node_modules", "@vscode", "test-cli", "out", "bin.mjs")],
    extensionRoot,
    {
      ...process.env,
      VSCODE_AGENT_BRIDGE_REGISTRY_DIR: registryDirectory,
      VSCODE_AGENT_BRIDGE_E2E: "1",
      VSCODE_AGENT_BRIDGE_E2E_WORKSPACE: workspaceDirectory,
    },
  );
} finally {
  await rm(registryDirectory, { recursive: true, force: true });
}

async function prepareWorkspace(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(path.join(extensionRoot, "test", "fixtures", "typescript-workspace"), target, {
    recursive: true,
  });
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
