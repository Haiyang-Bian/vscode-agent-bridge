import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";
import { sha256File } from "./lib/hash.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const artifactsDirectory = path.join(repositoryRoot, "artifacts");
const bundleName = `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-windows-x64-test-bundle`;
const bundleDirectory = path.join(artifactsDirectory, bundleName);
const bundleArchive = path.join(artifactsDirectory, `${bundleName}.zip`);
const vsixName = `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`;
const vsixSource = path.join(artifactsDirectory, vsixName);
const vsixDestination = path.join(bundleDirectory, vsixName);
const acceptanceSource = path.join(
  repositoryRoot,
  "docs",
  "acceptance",
  "windows-x64-cross-machine.md",
);
const acceptanceDestination = path.join(bundleDirectory, "ACCEPTANCE.md");

await rm(bundleDirectory, { recursive: true, force: true });
await rm(bundleArchive, { force: true });
await rm(`${bundleArchive}.sha256`, { force: true });
await mkdir(bundleDirectory, { recursive: true });
await copyFile(vsixSource, vsixDestination);
await copyFile(acceptanceSource, acceptanceDestination);

const vsixHash = await sha256File(vsixDestination);
const bundleManifest = {
  extensionId: "AliceLin.vscode-agent-bridge",
  version: BRIDGE_RELEASE_VERSION,
  platform: "win32-x64",
  marketplacePublished: false,
  installation: "VS Code: Extensions > ... > Install from VSIX...",
  vsix: {
    file: vsixName,
    sha256: vsixHash,
  },
};
await writeFile(
  path.join(bundleDirectory, "bundle.json"),
  `${JSON.stringify(bundleManifest, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(bundleDirectory, "README.txt"),
  [
    `VS Code Agent Bridge ${BRIDGE_RELEASE_VERSION} Windows x64 cross-machine candidate`,
    "",
    "1. Extract this archive on a different Windows x64 computer.",
    "2. Verify the files with: Get-Content .\\SHA256SUMS.txt; Get-FileHash .\\* -Algorithm SHA256",
    `3. In a clean VS Code profile, choose Extensions > ... > Install from VSIX... and select ${vsixName}.`,
    "4. Follow ACCEPTANCE.md. Do not install Bun or Node.js and do not clone the source repository.",
    "5. Treat this as an unpublished candidate; a passing report is required before Marketplace release.",
    "",
  ].join("\n"),
  "utf8",
);

const bundledFiles = ["README.txt", "ACCEPTANCE.md", "bundle.json", vsixName];
const bundledChecksums = await Promise.all(
  bundledFiles.map(async (file) => `${await sha256File(path.join(bundleDirectory, file))} *${file}`),
);
await writeFile(
  path.join(bundleDirectory, "SHA256SUMS.txt"),
  `${bundledChecksums.join("\n")}\n`,
  "utf8",
);

await run(["tar", "-a", "-cf", bundleArchive, "-C", artifactsDirectory, bundleName]);

const archiveListing = (await capture(["tar", "-tf", bundleArchive]))
  .split(/\r?\n/u)
  .map((entry) => entry.trim().replaceAll("\\", "/"))
  .filter(Boolean);
for (const file of [...bundledFiles, "SHA256SUMS.txt"]) {
  const expectedEntry = `${bundleName}/${file}`;
  if (!archiveListing.includes(expectedEntry)) {
    throw new Error(`Cross-machine bundle is missing ${expectedEntry}.`);
  }
}

const bundleHash = await sha256File(bundleArchive);
await writeFile(`${bundleArchive}.sha256`, `${bundleHash}\n`, "utf8");
const releaseChecksumsPath = path.join(artifactsDirectory, "SHA256SUMS.txt");
const releaseChecksumLines = (await readFile(releaseChecksumsPath, "utf8"))
  .split(/\r?\n/u)
  .filter((line) => line && !line.endsWith(`*${path.basename(bundleArchive)}`));
releaseChecksumLines.push(`${bundleHash} *${path.basename(bundleArchive)}`);
await writeFile(releaseChecksumsPath, `${releaseChecksumLines.join("\n")}\n`, "utf8");

console.log(`Created ${bundleArchive} (${bundleHash}).`);

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  return output;
}
