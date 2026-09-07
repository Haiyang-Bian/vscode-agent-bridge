import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyTestImpact,
  collectChangedPaths,
  getAllDomainTestFiles,
  parseTestDomains,
} from "./test-impact.ts";
import {
  cleanupE2EEnvironment,
  createE2EEnvironment,
  createE2EEnvironmentVariables,
  parseE2EScenarios,
} from "./e2e-runner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("test impact classification", () => {
  test("keeps documentation changes out of code gates", () => {
    const plan = classifyTestImpact(["docs/testing-strategy.md", "README.md"]);
    expect(plan.risk).toBe("docs");
    expect(plan.domains).toEqual([]);
    expect(plan.fullE2E).toBeFalse();
    expect(plan.commands).toEqual(["git diff --check", "git diff --cached --check"]);
  });

  test("adds the handbook validator without widening Agent guidance changes", () => {
    const plan = classifyTestImpact([
      "AGENTS.md",
      "packages/protocol/AGENTS.md",
      "docs/agent-handbook/README.md",
    ]);
    expect(plan.risk).toBe("docs");
    expect(plan.domains).toEqual([]);
    expect(plan.fullE2E).toBeFalse();
    expect(plan.commands).toEqual([
      "bun scripts/check-agent-handbook.ts",
      "git diff --check",
      "git diff --cached --check",
    ]);
  });

  test("treats executable VS Code developer configuration as full fast validation", () => {
    const plan = classifyTestImpact([
      "vscode-agent-bridge.code-workspace",
      ".vscode/tasks.json",
      ".vscode/launch.json",
    ]);
    expect(plan.risk).toBe("full");
    expect(plan.domains).toEqual(["release-tooling"]);
    expect(plan.fullE2E).toBeFalse();
    expect(plan.repeatE2E).toBeFalse();
    expect(plan.artifact).toBeFalse();
    expect(plan.commands).toEqual(["bun run check"]);
  });

  test("selects one extension domain without widening to the full gate", () => {
    const plan = classifyTestImpact(["packages/vscode-extension/src/terminal-capture.ts"]);
    expect(plan.risk).toBe("affected");
    expect(plan.domains).toEqual(["task-terminal"]);
    expect(plan.e2eScenarios).toEqual(["task-terminal"]);
    expect(plan.commands.some((command) => command.includes("terminal-capture.test.ts"))).toBeTrue();
  });

  test("treats protocol and cross-runtime changes as full validation", () => {
    const protocol = classifyTestImpact(["packages/protocol/src/ide.ts"]);
    expect(protocol.risk).toBe("full");
    expect(protocol.fullE2E).toBeTrue();

    const crossRuntime = classifyTestImpact([
      "packages/mcp-server/src/instances.ts",
      "packages/vscode-extension/src/local-usage-insights.ts",
    ]);
    expect(crossRuntime.risk).toBe("full");
    expect(crossRuntime.reasons.some((reason) => reason.includes("multiple runtime layers"))).toBeTrue();
  });

  test("allows additive domains and force-full but never lowers required gates", () => {
    const additive = classifyTestImpact(["packages/vscode-extension/src/local-usage-insights.ts"], {
      additionalDomains: ["debug"],
    });
    expect(additive.domains).toContain("ui-insights");
    expect(additive.domains).toContain("debug");

    const required = classifyTestImpact(["packages/protocol/src/ide.ts"], {
      additionalDomains: ["ui-insights"],
    });
    expect(required.risk).toBe("full");
    expect(classifyTestImpact(["README.md"], { forceFull: true }).risk).toBe("full");
  });

  test("fails closed for unknown production paths and marks packaging boundaries", () => {
    const unknown = classifyTestImpact(["packages/new-runtime/src/index.ts"]);
    expect(unknown.risk).toBe("full");
    expect(unknown.fullE2E).toBeTrue();

    const packaging = classifyTestImpact(["scripts/package-vsix.ts"]);
    expect(packaging.artifact).toBeTrue();
    expect(packaging.risk).toBe("full");
  });

  test("requires repeat E2E for harness and fixture changes", () => {
    const plan = classifyTestImpact(["packages/vscode-extension/test/e2e/extension.e2e.ts"]);
    expect(plan.risk).toBe("full");
    expect(plan.fullE2E).toBeTrue();
    expect(plan.repeatE2E).toBeTrue();

    const packaged = classifyTestImpact(["scripts/run-vsix-e2e.ts"]);
    expect(packaged.artifact).toBeTrue();
    expect(packaged.repeatE2E).toBeTrue();
    const httpLifecycle = classifyTestImpact(["scripts/test-http-window-lifecycle.ts", "packages/vscode-extension/test/http-lifecycle-harness/extension.js"]);
    expect(httpLifecycle.repeatE2E).toBeTrue();
    expect(httpLifecycle.artifact).toBeTrue();
    expect(classifyTestImpact(["packages/mcp-server/src/service-installer.ts", "packages/vscode-extension/tsconfig.json"]).artifact).toBeTrue();
  });

  test("validates explicit domain names", () => {
    expect(parseTestDomains(["debug,task-terminal", "debug"])).toEqual(["debug", "task-terminal"]);
    expect(() => parseTestDomains(["unknown"])).toThrow("Unknown test domain");
  });

  test("classifies every current production source and references existing tests", async () => {
    const repositoryRoot = path.resolve(import.meta.dir, "..", "..");
    const sourceRoots = [
      "packages/protocol/src",
      "packages/mcp-server/src",
      "packages/vscode-extension/src",
    ];
    const sourcePaths: string[] = [];
    for (const sourceRoot of sourceRoots) {
      const entries = await readdir(path.join(repositoryRoot, sourceRoot), { recursive: true });
      sourcePaths.push(
        ...entries
          .filter((entry) => entry.endsWith(".ts"))
          .map((entry) => `${sourceRoot}/${entry.replaceAll("\\", "/")}`),
      );
    }

    for (const sourcePath of sourcePaths) {
      const plan = classifyTestImpact([sourcePath]);
      expect(plan.reasons.some((reason) => reason.includes("Unclassified"))).toBeFalse();
      expect(plan.domains.length).toBeGreaterThan(0);
    }
    for (const testPath of getAllDomainTestFiles()) {
      expect((await stat(path.join(repositoryRoot, testPath))).isFile() || (await stat(path.join(repositoryRoot, testPath))).isDirectory()).toBeTrue();
    }
  });
});

describe("Git change collection", () => {
  test("includes staged, unstaged and untracked changes", async () => {
    const repository = await createRepository();
    await writeFile(path.join(repository, "tracked.txt"), "unstaged\n");
    await writeFile(path.join(repository, "staged.txt"), "staged\n");
    await runGit(repository, ["add", "staged.txt"]);
    await writeFile(path.join(repository, "untracked.txt"), "new\n");

    expect(await collectChangedPaths({ cwd: repository })).toEqual([
      "staged.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
  });

  test("keeps both sides of renames and includes deleted paths", async () => {
    const repository = await createRepository();
    await runGit(repository, ["mv", "tracked.txt", "renamed.txt"]);
    await runGit(repository, ["rm", "staged.txt"]);

    expect(await collectChangedPaths({ cwd: repository })).toEqual([
      "renamed.txt",
      "staged.txt",
      "tracked.txt",
    ]);
  });

  test("uses explicit base and head revisions in CI mode", async () => {
    const repository = await createRepository();
    const base = (await runGit(repository, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repository, "tracked.txt"), "second\n");
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, ["commit", "-m", "second"]);
    const head = (await runGit(repository, ["rev-parse", "HEAD"])).trim();

    expect(await collectChangedPaths({ cwd: repository, base, head })).toEqual(["tracked.txt"]);
  });

  test("test:plan fails closed when the base revision is unavailable", async () => {
    const repository = await createRepository();
    const script = path.resolve(import.meta.dir, "..", "test-plan.ts");
    const child = Bun.spawn(
      [process.execPath, script, "--base", "missing-base", "--format", "json"],
      { cwd: repository, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    const plan = JSON.parse(stdout) as ReturnType<typeof classifyTestImpact>;

    expect(exitCode).toBe(0);
    expect(plan.risk).toBe("full");
    expect(plan.fullE2E).toBeTrue();
    expect(plan.commands).toEqual(["bun run check"]);
    expect(plan.reasons.some((reason) => reason.includes("missing-base"))).toBeTrue();
  });
});

describe("E2E runner selection and cleanup", () => {
  test("expands full and validates individual scenarios", () => {
    expect(parseE2EScenarios([])).toHaveLength(9);
    expect(parseE2EScenarios(["http-bridge"])).toEqual(["http-bridge"]);
    expect(parseE2EScenarios(["debug,task-terminal", "debug"])).toEqual([
      "debug",
      "task-terminal",
    ]);
    expect(() => parseE2EScenarios(["full", "debug"])).toThrow();
    expect(() => parseE2EScenarios(["unknown"])).toThrow("Unknown E2E scenario");
  });

  test("removes the complete per-run profile root", async () => {
    const environment = await createE2EEnvironment("bridge-e2e-runner-test-");
    const variables = createE2EEnvironmentVariables(environment, ["http-bridge"]);
    expect(variables.VSCODE_AGENT_BRIDGE_SERVICE_DIR).toBe(path.join(environment.root, "http-service"));
    expect(variables.CODEX_HOME).toBe(path.join(environment.root, "codex-home"));
    await cleanupE2EEnvironment(environment);
    expect(await Bun.file(environment.root).exists()).toBeFalse();
  });

  test("uses one canonical root when the temporary parent has an alias", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-e2e-alias-test-"));
    temporaryDirectories.push(directory);
    const parent = path.join(directory, "actual-parent");
    const alias = path.join(directory, "alias-parent");
    await mkdir(parent);
    await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
    const environment = await createE2EEnvironment("fixture-", alias);
    try {
      expect(path.dirname(environment.root)).toBe(await realpath(parent));
      expect(environment.managedWorktrees).toBe(path.join(environment.root, "managed-worktrees"));
      expect(environment.workspace).toBe(path.join(environment.root, "workspace"));
    } finally {
      await cleanupE2EEnvironment(environment);
    }
  });
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-test-impact-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  await runGit(directory, ["init", "--initial-branch=main"]);
  await runGit(directory, ["config", "user.name", "Test Impact"]);
  await runGit(directory, ["config", "user.email", "impact@example.invalid"]);
  await writeFile(path.join(directory, "tracked.txt"), "initial\n");
  await writeFile(path.join(directory, "staged.txt"), "initial\n");
  await runGit(directory, ["add", "."]);
  await runGit(directory, ["commit", "-m", "initial"]);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
