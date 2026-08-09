import { defineConfig } from "@vscode/test-cli";

const workspaceFolder =
  process.env.VSCODE_AGENT_BRIDGE_E2E_WORKSPACE ?? "test/fixtures/typescript-workspace";

export default defineConfig({
  files: "dist-test/e2e/**/*.e2e.js",
  version: "stable",
  workspaceFolder,
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
