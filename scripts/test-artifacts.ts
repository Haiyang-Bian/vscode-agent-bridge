import path from "node:path";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const executablePath = path.join(
  repositoryRoot,
  "packages",
  "vscode-extension",
  "resources",
  "bin",
  "vscode-agent-bridge-mcp.exe",
);

await run(["bun", "scripts/verify-release.ts", "--require-artifacts"]);
await run(["bun", "test", "packages/mcp-server/test/service-process.test.ts"], {
  ...process.env,
  VSCODE_AGENT_BRIDGE_TEST_EXE: executablePath,
});
await run(["bun", "scripts/test-http-service.ts"]);
await run(["bun", "scripts/run-vsix-e2e.ts"]);

console.log(`Artifact smoke tests passed for ${BRIDGE_RELEASE_VERSION}.`);

async function run(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
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
