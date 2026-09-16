import path from "node:path";
import { startHttpE2EService } from "./lib/http-e2e-service.ts";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";
import { runVSCodeCommand } from "@vscode/test-electron";

import {
  assertE2ECompletion,
  cleanupE2EEnvironment,
  createE2EEnvironment,
  createE2EEnvironmentVariables,
  parseE2EScenarios,
  prepareFixtureWorkspace,
  runCommand,
} from "./lib/e2e-runner.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const vsixPath = path.join(
  repositoryRoot,
  "artifacts",
  `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`,
);
const scenarios = parseE2EScenarios(["full"]);
const environment = await createE2EEnvironment("vscode-agent-bridge-vsix-e2e-");
const httpService = await startHttpE2EService(environment, path.join(extensionRoot, "resources", "bin", "vscode-agent-bridge-mcp.exe"));

try {
  await prepareFixtureWorkspace(
    path.join(extensionRoot, "test", "fixtures", "typescript-workspace"),
    environment.workspace,
  );
  await runCommand(["bun", "run", "build:test:e2e"], extensionRoot);
  await runVSCodeCommand([
    "--install-extension",
    vsixPath,
    `--extensions-dir=${environment.extensions}`,
    `--user-data-dir=${environment.userData}`,
  ], {
    cachePath: path.join(extensionRoot, ".vscode-test"),
  });
  await runCommand(
    [
      "node",
      path.join(repositoryRoot, "node_modules", "@vscode", "test-cli", "out", "bin.mjs"),
      "--config",
      ".vscode-test-artifact.mjs",
    ],
    extensionRoot,
    createE2EEnvironmentVariables(environment, scenarios, {
      ...httpService.env,
      VSCODE_AGENT_BRIDGE_EXPECT_PACKAGED: "1",
    }),
  );
  await assertE2ECompletion(environment, scenarios);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await httpService.close(); } finally { await cleanupE2EEnvironment(environment); }
}
