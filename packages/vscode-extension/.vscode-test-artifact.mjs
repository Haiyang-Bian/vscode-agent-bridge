import { defineConfig } from "@vscode/test-cli";

const workspaceFolder =
  process.env.VSCODE_AGENT_BRIDGE_E2E_WORKSPACE ?? "test/fixtures/typescript-workspace";
const userDataDirectory = process.env.VSCODE_AGENT_BRIDGE_E2E_USER_DATA_DIR;
const extensionsDirectory = process.env.VSCODE_AGENT_BRIDGE_E2E_EXTENSIONS_DIR;

export default defineConfig({
  files: "dist-test/e2e/**/*.e2e.js",
  version: "stable",
  workspaceFolder,
  extensionDevelopmentPath: "test/harness",
  launchArgs: [
    ...(userDataDirectory ? [`--user-data-dir=${userDataDirectory}`] : []),
    ...(extensionsDirectory ? [`--extensions-dir=${extensionsDirectory}`] : []),
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
  ],
  mocha: {
    ui: "tdd",
    timeout: 90_000,
  },
});
