import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const handbookRoot = path.join(repositoryRoot, "docs", "agent-handbook");
const instructionFiles = [
  "AGENTS.md",
  "docs/AGENTS.md",
  "packages/protocol/AGENTS.md",
  "packages/mcp-server/AGENTS.md",
  "packages/vscode-extension/AGENTS.md",
  "scripts/AGENTS.md",
];
const requiredHandbookFiles = [
  "docs/agent-handbook/README.md",
  "docs/agent-handbook/project-overview.md",
  "docs/agent-handbook/architecture.md",
  "docs/agent-handbook/maintenance.md",
  "docs/agent-handbook/modules/protocol.md",
  "docs/agent-handbook/modules/mcp-server.md",
  "docs/agent-handbook/modules/vscode-extension.md",
  "docs/agent-handbook/modules/tooling-and-release.md",
  "docs/agent-handbook/playbooks/change-workflow.md",
  "docs/agent-handbook/playbooks/testing.md",
  "docs/agent-handbook/playbooks/debugging.md",
  "docs/agent-handbook/reference/commands.md",
  "docs/agent-handbook/reference/decision-index.md",
];

const errors: string[] = [];
const handbookFiles = await listMarkdownFiles(handbookRoot);
const checkedFiles = [...new Set([
  ...instructionFiles,
  ...requiredHandbookFiles,
  ...handbookFiles.map((file) => toRepositoryPath(file)),
  "README.md",
])];

for (const relativePath of [...instructionFiles, ...requiredHandbookFiles]) {
  if (!(await isFile(path.join(repositoryRoot, relativePath)))) {
    errors.push(`Missing required Agent guidance file: ${relativePath}`);
  }
}

let checkedLinks = 0;
for (const relativePath of checkedFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!(await isFile(absolutePath))) {
    continue;
  }
  const contents = await readFile(absolutePath, "utf8");
  if (/[A-Za-z]:[\\/](?:Users|home)[\\/]/i.test(contents)) {
    errors.push(`Machine-specific absolute path found in ${relativePath}`);
  }
  for (const target of extractLocalMarkdownLinks(contents)) {
    checkedLinks += 1;
    const resolved = path.resolve(path.dirname(absolutePath), target);
    if (!resolved.startsWith(`${repositoryRoot}${path.sep}`) && resolved !== repositoryRoot) {
      errors.push(`Link escapes the repository in ${relativePath}: ${target}`);
      continue;
    }
    if (!(await pathExists(resolved))) {
      errors.push(`Broken local link in ${relativePath}: ${target}`);
    }
  }
}

const rootInstructions = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");
for (const localInstructions of instructionFiles.filter((file) => file !== "AGENTS.md")) {
  const localContents = await readFile(path.join(repositoryRoot, localInstructions), "utf8");
  const chainBytes = Buffer.byteLength(`${rootInstructions}\n\n${localContents}`, "utf8");
  if (chainBytes > 32 * 1024) {
    errors.push(`Project instruction chain exceeds 32 KiB at ${localInstructions}: ${chainBytes} bytes`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  throw new Error(`Agent handbook validation failed with ${errors.length} error(s).`);
}

console.log(
  `Agent handbook validated (${handbookFiles.length} handbook pages, ${instructionFiles.length} instruction files, ${checkedLinks} local links).`,
);

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(child));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(child);
    }
  }
  return files.sort();
}

function extractLocalMarkdownLinks(contents: string): string[] {
  const links: string[] = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of contents.matchAll(pattern)) {
    let target = match[1]?.trim() ?? "";
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/u, 1)[0] ?? target;
    target = target.split("#", 1)[0] ?? target;
    if (!target || /^(?:https?:|mailto:|app:)/i.test(target)) {
      continue;
    }
    links.push(decodeURIComponent(target));
  }
  return links;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function toRepositoryPath(target: string): string {
  return path.relative(repositoryRoot, target).replaceAll("\\", "/");
}
