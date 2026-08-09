import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist-test/e2e/**/*.e2e.js",
  version: "stable",
  workspaceFolder: "test/fixtures/typescript-workspace",
  extensionDevelopmentPath: ".",
  launchArgs: [
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ],
  mocha: {
    ui: "tdd",
    timeout: 90_000,
  },
});
