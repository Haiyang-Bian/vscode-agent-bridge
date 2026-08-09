import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const outputDirectory = path.join(
  repositoryRoot,
  "packages",
  "vscode-extension",
  "resources",
  "bin",
);
const outputPath = path.join(outputDirectory, "vscode-agent-bridge-mcp.exe");

await mkdir(outputDirectory, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(repositoryRoot, "packages", "mcp-server", "src", "index.ts")],
  compile: {
    target: "bun-windows-x64-baseline",
    outfile: outputPath,
    autoloadDotenv: false,
    autoloadBunfig: false,
    windows: {
      title: "VS Code Agent Bridge MCP",
      description: "Authenticated local MCP bridge for VS Code",
      publisher: "Alice Lin",
      version: "0.2.0.0",
    },
  },
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
await writeFile(`${outputPath}.sha256`, `${digest}\n`, "utf8");
console.log(`Built ${path.relative(repositoryRoot, outputPath)} (${digest}).`);
