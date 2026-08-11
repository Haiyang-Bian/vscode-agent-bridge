import path from "node:path";

export const TEST_DOMAINS = [
  "protocol",
  "mcp-runtime",
  "lifecycle",
  "experiment-resource",
  "task-terminal",
  "debug",
  "extension-ecosystem",
  "managed-git",
  "ui-insights",
  "release-tooling",
] as const;

export const E2E_SCENARIOS = [
  "core-language",
  "lifecycle",
  "experiment-resource",
  "task-terminal",
  "debug",
  "extension-ecosystem",
  "master-switch",
  "managed-worktree",
] as const;

export const WORKSPACES = ["protocol", "mcp-server", "vscode-extension"] as const;

export type TestDomain = (typeof TEST_DOMAINS)[number];
export type E2EScenario = (typeof E2E_SCENARIOS)[number];
export type WorkspaceName = (typeof WORKSPACES)[number];
export type ImpactRisk = "none" | "docs" | "affected" | "full";

export interface ImpactOptions {
  additionalDomains?: readonly TestDomain[];
  forceFull?: boolean;
}

export interface ImpactPlan {
  changedPaths: string[];
  domains: TestDomain[];
  workspaces: WorkspaceName[];
  testFiles: string[];
  risk: ImpactRisk;
  fullE2E: boolean;
  e2eScenarios: E2EScenario[];
  repeatE2E: boolean;
  artifact: boolean;
  reasons: string[];
  commands: string[];
}

export interface GitChangeOptions {
  base?: string;
  head?: string;
  cwd?: string;
}

const WORKSPACE_DIRECTORIES: Record<WorkspaceName, string> = {
  protocol: "packages/protocol",
  "mcp-server": "packages/mcp-server",
  "vscode-extension": "packages/vscode-extension",
};

const DOMAIN_TEST_FILES: Record<TestDomain, readonly string[]> = {
  protocol: [
    "packages/protocol/test",
    "packages/mcp-server/test/stdio.test.ts",
    "packages/mcp-server/test/rpc-client.test.ts",
  ],
  "mcp-runtime": ["packages/mcp-server/test"],
  lifecycle: [
    "packages/mcp-server/test/instances.test.ts",
    "packages/mcp-server/test/rpc-client.test.ts",
    "packages/vscode-extension/test/codex-config.test.ts",
    "packages/vscode-extension/test/agent-activity.test.ts",
    "packages/protocol/test/registry.test.ts",
    "packages/protocol/test/rpc.test.ts",
  ],
  "experiment-resource": [
    "packages/vscode-extension/test/experiment-store.test.ts",
    "packages/protocol/test/experiment-contracts.test.ts",
    "packages/protocol/test/workflow-contracts.test.ts",
    "packages/protocol/test/ide-contracts.test.ts",
  ],
  "task-terminal": [
    "packages/vscode-extension/test/terminal-capture.test.ts",
    "packages/protocol/test/workflow-contracts.test.ts",
    "packages/protocol/test/ide-contracts.test.ts",
  ],
  debug: [
    "packages/vscode-extension/test/debug-output-capture.test.ts",
    "packages/protocol/test/workflow-contracts.test.ts",
    "packages/protocol/test/ide-contracts.test.ts",
  ],
  "extension-ecosystem": [
    "packages/vscode-extension/test/extension-install-boundary.test.ts",
    "packages/vscode-extension/test/extension-integration-registry.test.ts",
    "packages/vscode-extension/test/extension-marketplace.test.ts",
    "packages/vscode-extension/test/extension-profile-core.test.ts",
    "packages/vscode-extension/test/python-environment-integration.test.ts",
    "packages/protocol/test/extension-awareness-contracts.test.ts",
    "packages/protocol/test/extension-integration-contracts.test.ts",
    "packages/protocol/test/extension-orchestration-contracts.test.ts",
  ],
  "managed-git": [
    "packages/vscode-extension/test/git-baseline.test.ts",
    "packages/vscode-extension/test/git-runner.test.ts",
    "packages/protocol/test/experiment-contracts.test.ts",
  ],
  "ui-insights": [
    "packages/mcp-server/test/usage-insights.test.ts",
    "packages/vscode-extension/test/agent-activity.test.ts",
    "packages/vscode-extension/test/bridge-hub-manifest.test.ts",
    "packages/vscode-extension/test/local-usage-insights.test.ts",
  ],
  "release-tooling": ["scripts/lib/release-environment.test.ts"],
};

const DOMAIN_WORKSPACES: Record<TestDomain, readonly WorkspaceName[]> = {
  protocol: ["protocol", "mcp-server", "vscode-extension"],
  "mcp-runtime": ["mcp-server"],
  lifecycle: ["mcp-server", "vscode-extension"],
  "experiment-resource": ["vscode-extension"],
  "task-terminal": ["vscode-extension"],
  debug: ["vscode-extension"],
  "extension-ecosystem": ["vscode-extension"],
  "managed-git": ["vscode-extension"],
  "ui-insights": ["mcp-server", "vscode-extension"],
  "release-tooling": [],
};

const DOMAIN_E2E_SCENARIOS: Record<TestDomain, readonly E2EScenario[]> = {
  protocol: E2E_SCENARIOS,
  "mcp-runtime": ["core-language"],
  lifecycle: ["lifecycle", "master-switch"],
  "experiment-resource": ["experiment-resource"],
  "task-terminal": ["task-terminal"],
  debug: ["debug"],
  "extension-ecosystem": ["extension-ecosystem"],
  "managed-git": ["managed-worktree"],
  "ui-insights": [],
  "release-tooling": [],
};

const TEST_FILE_DOMAINS: ReadonlyArray<readonly [RegExp, TestDomain]> = [
  [/packages\/protocol\/test\/extension-(awareness|integration|orchestration)/, "extension-ecosystem"],
  [/packages\/protocol\/test\//, "protocol"],
  [/packages\/mcp-server\/test\/usage-insights/, "ui-insights"],
  [/packages\/mcp-server\/test\//, "mcp-runtime"],
  [/(experiment-store|experiment-contracts)/, "experiment-resource"],
  [/(terminal-capture)/, "task-terminal"],
  [/(debug-output-capture)/, "debug"],
  [/(git-baseline|git-runner)/, "managed-git"],
  [/(extension-awareness|extension-install|extension-integration|extension-marketplace|extension-profile|python-environment)/, "extension-ecosystem"],
  [/(agent-activity|bridge-hub|local-usage-insights)/, "ui-insights"],
  [/(codex-config|instances|rpc-client)/, "lifecycle"],
  [/scripts\/.*\.test\.ts$/, "release-tooling"],
];

export function classifyTestImpact(
  inputPaths: readonly string[],
  options: ImpactOptions = {},
): ImpactPlan {
  const changedPaths = [...new Set(inputPaths.map(normalizeRepositoryPath).filter(Boolean))].sort();
  const domains = new Set<TestDomain>();
  const workspaces = new Set<WorkspaceName>();
  const e2eScenarios = new Set<E2EScenario>();
  const reasons = new Set<string>();
  const runtimeLayers = new Set<WorkspaceName>();
  let risk: ImpactRisk = changedPaths.length === 0 ? "none" : "docs";
  let fullE2E = false;
  let repeatE2E = false;
  let artifact = false;
  let sawNonDocumentation = false;

  const markAffected = () => {
    sawNonDocumentation = true;
    if (risk === "none" || risk === "docs") {
      risk = "affected";
    }
  };
  const markFull = (reason: string, requireE2E = false) => {
    markAffected();
    risk = "full";
    reasons.add(reason);
    if (requireE2E) {
      fullE2E = true;
    }
  };
  const addDomain = (domain: TestDomain) => {
    domains.add(domain);
    for (const workspace of DOMAIN_WORKSPACES[domain]) {
      workspaces.add(workspace);
    }
  };

  for (const changedPath of changedPaths) {
    if (isDocumentationPath(changedPath)) {
      continue;
    }

    markAffected();

    if (isE2EInfrastructurePath(changedPath)) {
      addDomain("lifecycle");
      workspaces.add("vscode-extension");
      repeatE2E = true;
      fullE2E = true;
      reasons.add(`E2E infrastructure changed: ${changedPath}`);
      continue;
    }

    if (isTestPath(changedPath)) {
      const inferred = inferTestDomain(changedPath);
      if (inferred) {
        addDomain(inferred);
      }
      if (changedPath.includes("/test/fixtures/")) {
        fullE2E = true;
        repeatE2E = true;
        reasons.add(`E2E fixture changed: ${changedPath}`);
      }
      continue;
    }

    if (changedPath.startsWith("packages/protocol/src/")) {
      addDomain("protocol");
      runtimeLayers.add("protocol");
      markFull(`Shared protocol production code changed: ${changedPath}`, true);
      continue;
    }

    if (changedPath.startsWith("packages/mcp-server/src/")) {
      addDomain(changedPath.endsWith("usage-insights.ts") ? "ui-insights" : "mcp-runtime");
      workspaces.add("mcp-server");
      runtimeLayers.add("mcp-server");
      if (!changedPath.endsWith("usage-insights.ts")) {
        e2eScenarios.add("core-language");
      }
      if (changedPath.endsWith("index.ts")) {
        markFull("The MCP server composition root changed.", true);
      }
      continue;
    }

    if (changedPath.startsWith("packages/vscode-extension/src/")) {
      workspaces.add("vscode-extension");
      runtimeLayers.add("vscode-extension");
      classifyExtensionSource(changedPath, {
        addDomain,
        addScenario: (scenario) => e2eScenarios.add(scenario),
        markArtifact: () => {
          artifact = true;
        },
        markFull,
      });
      continue;
    }

    if (isManifestOrCompilerPath(changedPath)) {
      addDomain("release-tooling");
      artifact = isPackagingManifestPath(changedPath);
      markFull(`Manifest, dependency lock or compiler configuration changed: ${changedPath}`);
      continue;
    }

    if (changedPath.startsWith("scripts/")) {
      addDomain("release-tooling");
      if (isArtifactScript(changedPath)) {
        artifact = true;
      }
      markFull(`Repository build or release tooling changed: ${changedPath}`);
      continue;
    }

    if (changedPath.startsWith("packages/vscode-extension/resources/") || changedPath === "packages/vscode-extension/.vscodeignore") {
      addDomain("release-tooling");
      artifact = true;
      continue;
    }

    if (changedPath.startsWith(".github/workflows/")) {
      addDomain("release-tooling");
      continue;
    }

    if (changedPath.startsWith("packages/")) {
      markFull(`Unclassified package production path: ${changedPath}`, true);
      continue;
    }

    markFull(`Unclassified repository path: ${changedPath}`, true);
  }

  if (runtimeLayers.size > 1) {
    markFull(`Changes span multiple runtime layers: ${[...runtimeLayers].join(", ")}`, true);
  }

  for (const domain of options.additionalDomains ?? []) {
    markAffected();
    addDomain(domain);
    for (const scenario of DOMAIN_E2E_SCENARIOS[domain]) {
      e2eScenarios.add(scenario);
    }
    if (domain === "protocol") {
      fullE2E = true;
    }
    reasons.add(`Additional test domain requested: ${domain}`);
  }

  if (options.forceFull) {
    markFull("Full validation was explicitly requested.", true);
  }

  if (!sawNonDocumentation && changedPaths.length > 0) {
    risk = "docs";
  }

  const sortedDomains = sortByReference(domains, TEST_DOMAINS);
  const sortedWorkspaces = sortByReference(workspaces, WORKSPACES);
  const sortedScenarios = sortByReference(e2eScenarios, E2E_SCENARIOS);
  const testFiles = [...new Set(sortedDomains.flatMap((domain) => DOMAIN_TEST_FILES[domain]))].sort();

  return {
    changedPaths,
    domains: sortedDomains,
    workspaces: sortedWorkspaces,
    testFiles,
    risk,
    fullE2E,
    e2eScenarios: fullE2E ? [] : sortedScenarios,
    repeatE2E,
    artifact,
    reasons: [...reasons].sort(),
    commands: buildCommands(risk, sortedWorkspaces, testFiles),
  };
}

export async function collectChangedPaths(options: GitChangeOptions = {}): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  if (options.base) {
    const head = options.head ?? "HEAD";
    return splitNull(await runGit(["diff", "--name-only", "-z", options.base, head], cwd));
  }

  const [tracked, untracked] = await Promise.all([
    runGit(["diff", "--name-only", "-z", "HEAD"], cwd),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
  ]);
  return [...new Set([...splitNull(tracked), ...splitNull(untracked)])].sort();
}

export function parseTestDomains(values: readonly string[]): TestDomain[] {
  const domains: TestDomain[] = [];
  for (const value of values.flatMap((entry) => entry.split(","))) {
    if (!TEST_DOMAINS.includes(value as TestDomain)) {
      throw new Error(`Unknown test domain: ${value}`);
    }
    domains.push(value as TestDomain);
  }
  return [...new Set(domains)];
}

export function getDomainTestFiles(domains: readonly TestDomain[]): string[] {
  return [...new Set(domains.flatMap((domain) => DOMAIN_TEST_FILES[domain]))].sort();
}

export function getAllDomainTestFiles(): string[] {
  return getDomainTestFiles(TEST_DOMAINS);
}

export function getDomainE2EScenarios(domain: TestDomain): readonly E2EScenario[] {
  return DOMAIN_E2E_SCENARIOS[domain];
}

function classifyExtensionSource(
  changedPath: string,
  actions: {
    addDomain(domain: TestDomain): void;
    addScenario(scenario: E2EScenario): void;
    markArtifact(): void;
    markFull(reason: string, requireE2E?: boolean): void;
  },
): void {
  const fileName = path.posix.basename(changedPath);

  if (["extension.ts", "request-handlers.ts"].includes(fileName)) {
    actions.addDomain("lifecycle");
    actions.markFull(`Extension composition root changed: ${changedPath}`, true);
    return;
  }
  if (["bridge-host.ts", "workspace-onboarding.ts", "policies.ts", "codex-config.ts"].includes(fileName)) {
    actions.addDomain("lifecycle");
    actions.addScenario("lifecycle");
    actions.addScenario("master-switch");
    actions.markFull(`Lifecycle or policy boundary changed: ${changedPath}`);
    return;
  }
  if (/^(experiment-|change-set-|resource-change-|workspace-configuration-|ide-autonomy-)/.test(fileName)) {
    actions.addDomain("experiment-resource");
    actions.addScenario("experiment-resource");
    if (["experiment-manager.ts", "experiment-store.ts", "change-set-manager.ts", "resource-change-executor.ts"].includes(fileName)) {
      actions.markFull(`Recoverable mutation or persistence boundary changed: ${changedPath}`);
    }
    return;
  }
  if (/^(task-|terminal-)/.test(fileName)) {
    actions.addDomain("task-terminal");
    actions.addScenario("task-terminal");
    if (/^(task-manager|task-request-handlers)/.test(fileName)) {
      actions.markFull(`Task execution boundary changed: ${changedPath}`);
    }
    return;
  }
  if (/^debug-/.test(fileName)) {
    actions.addDomain("debug");
    actions.addScenario("debug");
    if (/^(debug-manager|debug-request-handlers)/.test(fileName)) {
      actions.markFull(`Debug execution boundary changed: ${changedPath}`);
    }
    return;
  }
  if (/^(git-|managed-worktree-)/.test(fileName)) {
    actions.addDomain("managed-git");
    actions.addScenario("managed-worktree");
    actions.markFull(`Git or Managed Worktree boundary changed: ${changedPath}`);
    return;
  }
  if (/^(extension-|marketplace-|python-environment-)/.test(fileName) || fileName === "installation.ts") {
    actions.addDomain("extension-ecosystem");
    actions.addScenario("extension-ecosystem");
    if (fileName === "installation.ts") {
      actions.markArtifact();
    }
    return;
  }
  if (/^(agent-|bridge-hub-|editor-|language-services|local-usage-insights)/.test(fileName) || fileName === "experiment-ui.ts") {
    actions.addDomain("ui-insights");
    if (fileName === "language-services.ts" || fileName === "editor-context.ts") {
      actions.addScenario("core-language");
    }
    return;
  }

  actions.markFull(`Unclassified extension production source: ${changedPath}`, true);
}

function inferTestDomain(changedPath: string): TestDomain | undefined {
  for (const [pattern, domain] of TEST_FILE_DOMAINS) {
    if (pattern.test(changedPath)) {
      return domain;
    }
  }
  return undefined;
}

function buildCommands(
  risk: ImpactRisk,
  workspaces: readonly WorkspaceName[],
  testFiles: readonly string[],
): string[] {
  if (risk === "full") {
    return ["bun run check"];
  }
  if (risk === "docs") {
    return ["git diff --check", "git diff --cached --check"];
  }
  if (risk === "none") {
    return [];
  }

  return [
    ...workspaces.map((workspace) => `bun run --cwd ${WORKSPACE_DIRECTORIES[workspace]} typecheck`),
    ...(testFiles.length > 0 ? [`bun test ${testFiles.join(" ")}`] : []),
    ...workspaces.map((workspace) => `bun run --cwd ${WORKSPACE_DIRECTORIES[workspace]} build`),
  ];
}

function isDocumentationPath(changedPath: string): boolean {
  return (
    changedPath.startsWith("docs/") ||
    changedPath.endsWith(".md") ||
    ["LICENSE", "SECURITY.md", "AGENTS.md"].includes(changedPath)
  );
}

function isE2EInfrastructurePath(changedPath: string): boolean {
  return (
    changedPath === "scripts/run-extension-e2e.ts" ||
    changedPath === "scripts/run-vsix-e2e.ts" ||
    changedPath === "scripts/test-e2e-affected.ts" ||
    changedPath === "scripts/lib/e2e-runner.ts" ||
    changedPath === "packages/vscode-extension/.vscode-test.mjs" ||
    changedPath === "packages/vscode-extension/.vscode-test-artifact.mjs" ||
    changedPath.startsWith("packages/vscode-extension/test/e2e/") ||
    changedPath.startsWith("packages/vscode-extension/test/harness/")
  );
}

function isTestPath(changedPath: string): boolean {
  return changedPath.includes("/test/") || changedPath.endsWith(".test.ts");
}

function isManifestOrCompilerPath(changedPath: string): boolean {
  return (
    changedPath === "package.json" ||
    changedPath === "bun.lock" ||
    changedPath === "bun.lockb" ||
    changedPath.endsWith("/package.json") ||
    /(^|\/)tsconfig[^/]*\.json$/.test(changedPath)
  );
}

function isPackagingManifestPath(changedPath: string): boolean {
  return changedPath === "package.json" || changedPath === "bun.lock" || changedPath === "bun.lockb" || changedPath.endsWith("/package.json");
}

function isArtifactScript(changedPath: string): boolean {
  return /scripts\/(build-mcp-executable|package-vsix|create-test-bundle|create-checksums|test-artifacts|run-vsix-e2e|verify-release)\.ts$/.test(changedPath);
}

function normalizeRepositoryPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function sortByReference<T extends string>(values: ReadonlySet<T>, reference: readonly T[]): T[] {
  return [...values].sort((left, right) => reference.indexOf(left) - reference.indexOf(right));
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

function splitNull(value: string): string[] {
  return value.split("\0").map(normalizeRepositoryPath).filter(Boolean);
}
