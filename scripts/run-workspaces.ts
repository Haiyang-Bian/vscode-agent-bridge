import path from "node:path";

const workspaceOrder = [
  "packages/protocol",
  "packages/mcp-server",
  "packages/vscode-extension",
] as const;

const scriptName = Bun.argv[2];

if (!scriptName) {
  console.error("Usage: bun scripts/run-workspaces.ts <script>");
  process.exit(2);
}

for (const workspace of workspaceOrder) {
  const workspaceDirectory = path.resolve(import.meta.dir, "..", workspace);
  const manifest = await Bun.file(path.join(workspaceDirectory, "package.json")).json();

  if (!manifest.scripts?.[scriptName]) {
    continue;
  }

  console.log(`\n> ${workspace} ${scriptName}`);
  const child = Bun.spawn(["bun", "run", scriptName], {
    cwd: workspaceDirectory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
