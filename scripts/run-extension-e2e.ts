import path from "node:path";
import { startHttpE2EService } from "./lib/http-e2e-service.ts";

import {
  assertE2ECompletion,
  cleanupE2EEnvironment,
  createE2EEnvironment,
  createE2EEnvironmentVariables,
  parseE2EScenarios,
  prepareFixtureWorkspace,
  runCommand,
  stageDevelopmentExtension,
  writeRunnerEvidence,
} from "./lib/e2e-runner.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const { repeat, scenarios } = parseArguments(Bun.argv.slice(2));

try {
  await runCommand(["bun", "run", "build"], repositoryRoot);
  await runCommand(["bun", "run", "build:test:e2e"], extensionRoot);

  for (let iteration = 1; iteration <= repeat; iteration += 1) {
    const environment = await createE2EEnvironment("vscode-agent-bridge-e2e-");
    const httpService = scenarios.includes("http-bridge") ? await startHttpE2EService(environment) : undefined;
    try {
      await prepareFixtureWorkspace(
        path.join(extensionRoot, "test", "fixtures", "typescript-workspace"),
        environment.workspace,
      );
      await stageDevelopmentExtension(extensionRoot, environment.stagedExtension);
      await runCommand(
        ["node", path.join(repositoryRoot, "node_modules", "@vscode", "test-cli", "out", "bin.mjs")],
        extensionRoot,
        createE2EEnvironmentVariables(environment, scenarios, httpService?.env),
      );
      await assertE2ECompletion(environment, scenarios);
      await writeRunnerEvidence(path.join(environment.root, "runner-e2e-passed.json"), {
        iteration,
        repeat,
        scenarios,
        cleanupPending: true,
      });
    } finally {
      try { await httpService?.close(); } finally { await cleanupE2EEnvironment(environment); }
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

function parseArguments(args: string[]): { repeat: number; scenarios: ReturnType<typeof parseE2EScenarios> } {
  let repeat = 1;
  const scenarioValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--repeat") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error("--repeat must be an integer between 1 and 5.");
      }
      repeat = value;
      index += 1;
    } else {
      scenarioValues.push(args[index]);
    }
  }
  return { repeat, scenarios: parseE2EScenarios(scenarioValues) };
}
