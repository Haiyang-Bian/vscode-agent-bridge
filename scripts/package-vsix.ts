import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const artifactsDirectory = path.join(repositoryRoot, "artifacts");
const vsixPath = path.join(
  artifactsDirectory,
  `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`,
);
const bundledExecutablePath = path.join(
  extensionRoot,
  "resources",
  "bin",
  "vscode-agent-bridge-mcp.exe",
);
const releaseExecutablePath = path.join(
  artifactsDirectory,
  `vscode-agent-bridge-mcp-${BRIDGE_RELEASE_VERSION}-win32-x64.exe`,
);

const nodeVersion = (await capture(["node", "--version"], repositoryRoot)).trim();
const nodeMajor = Number(nodeVersion.match(/^v(\d+)/u)?.[1]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  throw new Error(`Packaging requires Node.js 22 or newer for vsce; found ${nodeVersion}.`);
}

await run(["bun", "run", "build"], repositoryRoot);
await run(["bun", "run", "build:mcp:exe"], repositoryRoot);
await run(["bun", "scripts/verify-release.ts", "--require-executable"], repositoryRoot);

await mkdir(artifactsDirectory, { recursive: true });
await rm(vsixPath, { force: true });
await copyFile(bundledExecutablePath, releaseExecutablePath);
await copyFile(`${bundledExecutablePath}.sha256`, `${releaseExecutablePath}.sha256`);
const vscePath = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
await run(
  [
    "node",
    vscePath,
    "package",
    "--target",
    "win32-x64",
    "--no-dependencies",
    "--out",
    vsixPath,
  ],
  extensionRoot,
);

const contents = await capture(
  ["node", vscePath, "ls", "--no-dependencies"],
  extensionRoot,
);
await writeFile(path.join(artifactsDirectory, "vsix-contents.txt"), contents, "utf8");
await run(["bun", "scripts/verify-release.ts", "--require-artifacts"], repositoryRoot);

console.log(`Created ${vsixPath}`);

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

async function capture(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  return output;
}
