import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  MCP_TOOL_NAMES,
} from "@vscode-agent-bridge/protocol";
import { sha256File } from "./lib/hash.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repositoryRoot, "packages", "vscode-extension");
const vscePath = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
const executablePath = path.join(
  extensionRoot,
  "resources",
  "bin",
  "vscode-agent-bridge-mcp.exe",
);
const vsixPath = path.join(
  repositoryRoot,
  "artifacts",
  `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`,
);
const releaseExecutablePath = path.join(
  repositoryRoot,
  "artifacts",
  `vscode-agent-bridge-mcp-${BRIDGE_RELEASE_VERSION}-win32-x64.exe`,
);
const requireExecutable = process.argv.includes("--require-executable");
const requireArtifacts = process.argv.includes("--require-artifacts");

const manifests = await Promise.all(
  [
    "package.json",
    "packages/protocol/package.json",
    "packages/mcp-server/package.json",
    "packages/vscode-extension/package.json",
  ].map(async (relativePath) => ({
    relativePath,
    manifest: JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8")) as Record<
      string,
      unknown
    >,
  })),
);

for (const { relativePath, manifest } of manifests) {
  assert(manifest.version === BRIDGE_RELEASE_VERSION, `${relativePath} version is not aligned.`);
}

const extensionManifest = manifests.at(-1)!.manifest;
const rootDevDependencies = manifests[0]!.manifest.devDependencies as Record<string, unknown>;
assert(extensionManifest.publisher === "Haiyang-Bian", "Extension publisher is not Haiyang-Bian.");
assert(extensionManifest.license === "MIT", "Extension license is not MIT.");
assert(extensionManifest.private === undefined, "Published extension must not be private.");
assert(
  Array.isArray(extensionManifest.extensionKind) && extensionManifest.extensionKind.includes("ui"),
  "Extension must run as a desktop UI extension.",
);
assert(MCP_TOOL_NAMES.length === 8, "The release must expose exactly eight MCP tools.");
assert(
  rootDevDependencies["@vscode/vsce"] === "3.9.3-4",
  "The release must pin the verified OIDC-capable vsce build exactly.",
);
assert(
  (await capture(["node", vscePath, "publish", "--help"], repositoryRoot)).includes("--oidc"),
  "The installed vsce does not implement trusted publishing with --oidc.",
);
assert(
  MCP_TOOL_NAMES.every(
    (name) => !/(^|_)(write|edit|rename|command|terminal|shell|execute)(_|$)/iu.test(name),
  ),
  "The v0.2.0 MCP surface must remain read-only and IDE-native.",
);

const releaseTag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (releaseTag) {
  assert(releaseTag === `v${BRIDGE_RELEASE_VERSION}`, `Tag ${releaseTag} does not match the release.`);
}

if (requireExecutable || requireArtifacts) {
  const expectedHash = (await readFile(`${executablePath}.sha256`, "utf8")).trim().toLowerCase();
  assert(expectedHash === (await sha256File(executablePath)), "MCP executable SHA-256 mismatch.");

  const selfTest = JSON.parse(
    await capture([executablePath, "--self-test"], repositoryRoot),
  ) as Record<string, unknown>;
  assert(selfTest.version === BRIDGE_RELEASE_VERSION, "MCP executable version mismatch.");
  assert(selfTest.protocolVersion === BRIDGE_PROTOCOL_VERSION, "MCP protocol version mismatch.");
  assert(selfTest.platform === "win32" && selfTest.architecture === "x64", "Wrong MCP target.");
}

if (requireArtifacts) {
  assert(
    (await sha256File(releaseExecutablePath)) === (await sha256File(executablePath)),
    "Standalone release executable does not match the VSIX executable.",
  );
  await auditVsix(vsixPath);
}

console.log(
  `Release ${BRIDGE_RELEASE_VERSION} verified (${MCP_TOOL_NAMES.length} read-only tools, protocol v${BRIDGE_PROTOCOL_VERSION}).`,
);

async function auditVsix(archivePath: string): Promise<void> {
  const listing = (await capture(["tar", "-tf", archivePath], repositoryRoot))
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  const requiredEntries = [
    "extension/package.json",
    "extension/dist/extension.js",
    "extension/resources/icon.png",
    "extension/resources/bin/vscode-agent-bridge-mcp.exe",
    "extension/resources/bin/vscode-agent-bridge-mcp.exe.sha256",
    "extension/readme.md",
    "extension/changelog.md",
    "extension/LICENSE.txt",
    "extension/SECURITY.md",
    "extension/THIRD_PARTY_NOTICES.md",
  ];
  for (const entry of requiredEntries) {
    assert(listing.includes(entry), `VSIX is missing ${entry}.`);
  }
  for (const entry of listing) {
    assert(!/(?:^|\/)(?:src|test|node_modules|\.codex|\.idea)(?:\/|$)/iu.test(entry), `Forbidden VSIX entry: ${entry}`);
    assert(!/\.(?:ts|map|tmp)$/iu.test(entry), `Development file leaked into VSIX: ${entry}`);
  }

  const extractionDirectory = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-vsix-"));
  try {
    await run(["tar", "-xf", archivePath, "-C", extractionDirectory], repositoryRoot);
    const files = await walkFiles(extractionDirectory);
    const forbiddenMachineStrings = [os.homedir(), repositoryRoot]
      .flatMap((value) => [value, value.replaceAll("\\", "/")])
      .map((value) => value.toLowerCase());
    for (const file of files) {
      const bytes = await readFile(file);
      const searchable = bytes.toString("utf8").toLowerCase();
      for (const forbidden of forbiddenMachineStrings) {
        assert(!searchable.includes(forbidden), `Developer machine path leaked into ${file}.`);
      }
    }
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with code ${exitCode}.`);
  }
}

async function capture(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with code ${exitCode}.`);
  }
  return output.trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
