import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";
import { sha256File } from "./lib/hash.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const artifactsDirectory = path.join(repositoryRoot, "artifacts");
const executablePath = path.join(
  artifactsDirectory,
  `vscode-agent-bridge-mcp-${BRIDGE_RELEASE_VERSION}-win32-x64.exe`,
);
const vsixPath = path.join(
  artifactsDirectory,
  `vscode-agent-bridge-${BRIDGE_RELEASE_VERSION}-win32-x64.vsix`,
);
const files = [executablePath, vsixPath];
const lines = await Promise.all(
  files.map(async (file) => `${await sha256File(file)} *${path.basename(file)}`),
);
await writeFile(path.join(artifactsDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
await writeFile(`${vsixPath}.sha256`, `${await sha256File(vsixPath)}\n`, "utf8");

const executableHash = (await readFile(`${executablePath}.sha256`, "utf8")).trim();
if (executableHash !== lines[0]!.split(" ")[0]) {
  throw new Error("Existing executable sidecar does not match SHA256SUMS.txt.");
}
