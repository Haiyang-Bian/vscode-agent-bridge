import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  MCP_TOOL_NAMES,
} from "@vscode-agent-bridge/protocol";
import { sha256File } from "./lib/hash.ts";
import { resolveReleaseTag } from "./lib/release-environment.ts";

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
assert(extensionManifest.publisher === "AliceLin", "Extension publisher is not AliceLin.");
assert(extensionManifest.license === "MIT", "Extension license is not MIT.");
assert(extensionManifest.private === undefined, "Published extension must not be private.");
assert(
  Array.isArray(extensionManifest.extensionKind) && extensionManifest.extensionKind.includes("ui"),
  "Extension must run as a desktop UI extension.",
);
assert(MCP_TOOL_NAMES.length === 53, "The release must expose exactly fifty-three MCP tools.");
assert(
  rootDevDependencies["@vscode/vsce"] === "3.9.3-4",
  "The release must pin the verified OIDC-capable vsce build exactly.",
);
const gitRunnerSource = await readFile(
  path.join(extensionRoot, "src", "git-runner.ts"),
  "utf8",
);
for (const forbidden of [
  /\["fetch"/u,
  /\["pull"/u,
  /\["push"/u,
  /\["remote"/u,
  /\["config"/u,
  /worktree",\s*"prune/u,
  /reset",\s*"--hard/u,
  /shell\s*:/u,
]) {
  assert(!forbidden.test(gitRunnerSource), `Forbidden Git execution pattern: ${forbidden}.`);
}
assert(gitRunnerSource.includes("execFile"), "Managed Git operations must use execFile.");
const terminalObserverSource = await readFile(
  path.join(extensionRoot, "src", "terminal-observer.ts"),
  "utf8",
);
for (const forbidden of [
  /window\.createTerminal/u,
  /\.sendText\s*\(/u,
  /shellIntegration\?*\.executeCommand\s*\(/u,
  /terminal\.(?:show|hide|dispose)\s*\(/u,
]) {
  assert(
    !forbidden.test(terminalObserverSource),
    `Forbidden terminal mutation pattern in TerminalObserver: ${forbidden}.`,
  );
}
assert(
  (await capture(["node", vscePath, "publish", "--help"], repositoryRoot)).includes("--oidc"),
  "The installed vsce does not implement trusted publishing with --oidc.",
);
assert(
  MCP_TOOL_NAMES.every((name) => name.startsWith("vscode_")) &&
    MCP_TOOL_NAMES.every((name) => !/(shell|execute_command|filesystem|git_)/iu.test(name)),
  "The MCP surface must remain IDE-native and must not expose shell, filesystem or Git commands.",
);
assert(
  [
    "vscode_prepare_text_edits",
    "vscode_prepare_rename",
    "vscode_apply_change_set",
    "vscode_record_experiment_evidence",
    "vscode_save_document",
    "vscode_format_document",
    "vscode_list_code_actions",
    "vscode_apply_code_action",
    "vscode_start_experiment",
    "vscode_rename_experiment",
    "vscode_create_experiment_checkpoint",
    "vscode_update_workspace_configuration",
    "vscode_prepare_resource_changes",
    "vscode_run_task",
    "vscode_terminate_task",
    "vscode_start_debug_session",
    "vscode_control_debug_session",
    "vscode_update_breakpoints",
    "vscode_evaluate_debug_expression",
    "vscode_set_debug_variable",
  ].every((name) => MCP_TOOL_NAMES.includes(name)),
  "The guarded IDE workflow mutation surface is incomplete.",
);
assert(
  MCP_TOOL_NAMES.filter((name) => name.includes("terminal")).join(",") ===
    [
      "vscode_list_terminals",
      "vscode_list_terminal_executions",
      "vscode_read_terminal_output",
    ].join(","),
  "Only the three bounded read-only terminal observation tools may be exposed.",
);
assert(
  MCP_TOOL_NAMES.filter((name) => name.includes("task")).join(",") ===
    [
      "vscode_list_tasks",
      "vscode_run_task",
      "vscode_list_task_executions",
      "vscode_terminate_task",
    ].join(","),
  "The Task surface must remain the four fingerprinted workspace workflow tools.",
);
assert(
  MCP_TOOL_NAMES.filter((name) => name.includes("debug") || name.includes("breakpoint")).join(",") ===
    [
      "vscode_list_debug_configurations",
      "vscode_start_debug_session",
      "vscode_list_debug_sessions",
      "vscode_get_debug_state",
      "vscode_control_debug_session",
      "vscode_list_breakpoints",
      "vscode_update_breakpoints",
      "vscode_evaluate_debug_expression",
      "vscode_set_debug_variable",
    ].join(","),
  "The Debug surface must remain the nine bounded launch, state, control and breakpoint tools.",
);

const releaseTag = resolveReleaseTag(process.env);
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
  `Release ${BRIDGE_RELEASE_VERSION} verified (${MCP_TOOL_NAMES.length} bounded IDE tools, protocol v${BRIDGE_PROTOCOL_VERSION}).`,
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
    "extension/resources/experiment.svg",
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
      assert(
        !searchable.includes("vscode-agent-bridge-e2e") &&
          !searchable.includes("bridgee2edebugadapter"),
        `Test-only Debug Adapter leaked into ${file}.`,
      );
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
