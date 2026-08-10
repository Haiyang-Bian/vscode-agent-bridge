import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const sourcePath = path.resolve(
  process.cwd(),
  "packages",
  "vscode-extension",
  "src",
  "extension-marketplace-manager.ts",
);

describe("native extension installation boundary", () => {
  test("uses only fixed VS Code UI commands and never falls back to CLI or arbitrary artifacts", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('const NATIVE_INSTALL_COMMAND = "workbench.extensions.installExtension"');
    expect(source).toContain('const NATIVE_DETAILS_COMMAND = "workbench.extensions.action.showExtensionsWithIds"');
    expect(source).not.toMatch(/--install-extension|--uninstall-extension|\.vsix|child_process|execFile|spawn\s*\(/iu);
    expect(source.match(/vscode\.commands\.executeCommand\(/gu)?.length).toBe(2);
    expect(source).not.toContain("Extension.activate(");
  });
});
