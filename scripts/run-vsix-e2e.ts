import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const vsixPath = path.join(
  repositoryRoot,
  "artifacts",
  `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`,
);
const registryDirectory = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-vsix-e2e-"));
const testCacheDirectory = path.resolve(extensionRoot, ".vscode-test");
const isolatedProfilePaths = [
  path.join(testCacheDirectory, "extensions"),
  path.join(testCacheDirectory, "user-data"),
];

try {
  await resetIsolatedProfile();
  await run(["bun", "run", "build:test:e2e"], extensionRoot);
  await run(
    [
      "node",
      path.join(repositoryRoot, "node_modules", "@vscode", "test-cli", "out", "bin.mjs"),
      "--config",
      ".vscode-test-artifact.mjs",
      "--install-extensions",
      vsixPath,
    ],
    extensionRoot,
    {
      ...process.env,
      VSCODE_AGENT_BRIDGE_REGISTRY_DIR: registryDirectory,
      VSCODE_AGENT_BRIDGE_E2E: "1",
      VSCODE_AGENT_BRIDGE_EXPECT_PACKAGED: "1",
    },
  );
} finally {
  await Promise.all([
    rm(registryDirectory, { recursive: true, force: true }),
    resetIsolatedProfile(),
  ]);
}

async function resetIsolatedProfile(): Promise<void> {
  for (const candidate of isolatedProfilePaths) {
    if (path.dirname(path.resolve(candidate)) !== testCacheDirectory) {
      throw new Error(`Refusing to remove a VS Code test profile outside ${testCacheDirectory}.`);
    }
    await rm(candidate, { recursive: true, force: true });
  }
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
