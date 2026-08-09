import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "bun:test";

import { GitRunner, assertBranchName, isPathWithin } from "../src/git-runner.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("fixed Git runner", () => {
  test("creates a locked worktree and promotes the accepted tree as one commit", async () => {
    const { repository, root, baseHead } = await createRepository();
    const runner = new GitRunner();
    const inspected = await runner.inspectRepository(repository);
    expect(inspected).toMatchObject({
      repositoryRoot: await realpath(repository),
      branch: "main",
      head: baseHead,
      clean: true,
      bare: false,
      operation: null,
      hasSubmodules: false,
    });

    const worktreePath = path.join(root, "managed", "session");
    const experimentBranch = "vscode-agent-bridge/experiment/20260809-deadbeef";
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runner.addWorktree(repository, worktreePath, experimentBranch, baseHead);
    await runner.lockWorktree(repository, worktreePath, "managed test");
    expect(await runner.listWorktrees(repository)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.resolve(worktreePath),
          branch: experimentBranch,
          locked: true,
        }),
      ]),
    );

    await writeFile(path.join(worktreePath, "app.ts"), "export const value = 2;\n", "utf8");
    const accepted = await runner.createPrivateCommit(worktreePath, "private checkpoint");
    expect(await runner.head(repository)).toBe(baseHead);
    expect(await runner.branchHead(repository, experimentBranch)).toBe(accepted);
    expect(await runner.isAncestor(repository, baseHead, accepted)).toBe(true);
    expect(await runner.commitsBetween(repository, baseHead, accepted)).toEqual([accepted]);
    expect((await runner.diffSummary(repository, baseHead, accepted)).files).toEqual(["app.ts"]);

    const acceptedTree = await runner.tree(repository, accepted);
    const temporaryCommit = await runner.commitTree(
      repository,
      acceptedTree,
      baseHead,
      "formal delivery",
    );
    await runner.cherryPick(repository, temporaryCommit);
    const formalHead = await runner.head(repository);
    expect(await runner.commitParents(repository, formalHead)).toEqual([baseHead]);
    expect(await runner.tree(repository, formalHead)).toBe(acceptedTree);
    expect((await runner.inspectRepository(repository)).clean).toBe(true);

    await runner.unlockWorktree(repository, worktreePath);
    await runner.removeWorktree(repository, worktreePath, false);
    expect((await runner.listWorktrees(repository)).some((entry) => entry.path === path.resolve(worktreePath))).toBe(false);
    expect(await runner.branchUpstream(repository, experimentBranch)).toBeNull();
    await git(repository, ["update-ref", `refs/heads/${experimentBranch}`, formalHead, accepted]);
    await expect(runner.deleteBranchRef(repository, experimentBranch, accepted)).rejects.toThrow();
    expect(await runner.branchHead(repository, experimentBranch)).toBe(formalHead);
    await runner.deleteBranchRef(repository, experimentBranch, formalHead);
    await expect(runner.branchHead(repository, experimentBranch)).rejects.toThrow();
  });

  test("rebases only after the target advances from the recorded base", async () => {
    const { repository, root, baseHead } = await createRepository();
    const runner = new GitRunner();
    const worktreePath = path.join(root, "managed", "sync");
    const branch = "vscode-agent-bridge/experiment/20260809-cafebabe";
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runner.addWorktree(repository, worktreePath, branch, baseHead);
    await writeFile(path.join(worktreePath, "experiment.ts"), "export const experiment = true;\n", "utf8");
    const oldExperimentHead = await runner.createPrivateCommit(worktreePath, "experiment change");

    await writeFile(path.join(repository, "target.ts"), "export const target = true;\n", "utf8");
    await git(repository, ["add", "target.ts"]);
    await git(repository, ["commit", "-m", "target moves"]);
    const newTargetHead = await runner.head(repository);
    expect(await runner.isAncestor(repository, baseHead, newTargetHead)).toBe(true);
    await runner.rebaseOnto(worktreePath, newTargetHead, baseHead);
    const rebasedHead = await runner.head(worktreePath);
    expect(rebasedHead).not.toBe(oldExperimentHead);
    expect(await runner.isAncestor(worktreePath, newTargetHead, rebasedHead)).toBe(true);
    expect(await runner.hasMergeCommit(worktreePath, newTargetHead)).toBe(false);
  });

  test("rejects unsafe branch names and broad paths", () => {
    expect(() => assertBranchName("../escape")).toThrow();
    expect(() => assertBranchName("bad branch")).toThrow();
    expect(assertBranchName("vscode-agent-bridge/experiment/safe")).toContain("experiment");
    expect(isPathWithin("C:/managed/root", "C:/managed/root/session")).toBe(true);
    expect(isPathWithin("C:/managed/root", "C:/managed/other")).toBe(false);
  });

  test("leaves a conflicted rebase recoverable and aborts without hard reset", async () => {
    const { repository, root, baseHead } = await createRepository();
    const runner = new GitRunner();
    const worktreePath = path.join(root, "managed", "conflict");
    const branch = "vscode-agent-bridge/experiment/20260809-conflict";
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runner.addWorktree(repository, worktreePath, branch, baseHead);
    await writeFile(path.join(worktreePath, "app.ts"), "export const value = 2;\n", "utf8");
    const privateHead = await runner.createPrivateCommit(worktreePath, "private conflict");

    await writeFile(path.join(repository, "app.ts"), "export const value = 3;\n", "utf8");
    await git(repository, ["add", "app.ts"]);
    await git(repository, ["commit", "-m", "target conflict"]);
    const targetHead = await runner.head(repository);
    await expect(runner.rebaseOnto(worktreePath, targetHead, baseHead)).rejects.toThrow();
    expect((await runner.inspectRepository(worktreePath)).operation).toBe("rebase");
    await runner.abortRebase(worktreePath);
    expect(await runner.head(worktreePath)).toBe(privateHead);
    expect(await runner.inspectRepository(worktreePath)).toMatchObject({ clean: true, operation: null });
  });

  test("detects merge histories, detached heads, dirty targets and submodule metadata", async () => {
    const { repository, root, baseHead } = await createRepository();
    const runner = new GitRunner();
    const worktreePath = path.join(root, "managed", "merge");
    const branch = "vscode-agent-bridge/experiment/20260809-merge";
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await runner.addWorktree(repository, worktreePath, branch, baseHead);
    await git(worktreePath, ["checkout", "-b", "private-side"]);
    await writeFile(path.join(worktreePath, "side.ts"), "export const side = true;\n", "utf8");
    await git(worktreePath, ["add", "side.ts"]);
    await git(worktreePath, ["commit", "-m", "side"]);
    await git(worktreePath, ["checkout", branch]);
    await writeFile(path.join(worktreePath, "main.ts"), "export const main = true;\n", "utf8");
    await git(worktreePath, ["add", "main.ts"]);
    await git(worktreePath, ["commit", "-m", "main"]);
    await git(worktreePath, ["merge", "--no-ff", "private-side", "-m", "private merge"]);
    expect(await runner.hasMergeCommit(worktreePath, baseHead)).toBe(true);

    await writeFile(path.join(repository, ".gitmodules"), "[submodule \"demo\"]\n\tpath = demo\n\turl = local\n", "utf8");
    await git(repository, ["add", ".gitmodules"]);
    expect(await runner.inspectRepository(repository)).toMatchObject({ clean: false, hasSubmodules: true });
    await git(repository, ["restore", "--staged", "--", ".gitmodules"]);
    await rm(path.join(repository, ".gitmodules"), { force: true });
    await git(repository, ["checkout", "--detach", "HEAD"]);
    expect((await runner.inspectRepository(repository)).branch).toBeNull();
  });
});

async function createRepository(): Promise<{ repository: string; root: string; baseHead: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-runner-"));
  directories.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Bridge Test"]);
  await git(repository, ["config", "user.email", "bridge@example.invalid"]);
  await writeFile(path.join(repository, "app.ts"), "export const value = 1;\n", "utf8");
  await git(repository, ["add", "app.ts"]);
  await git(repository, ["commit", "-m", "base"]);
  return { repository, root, baseHead: await revParse(repository, "HEAD") };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function revParse(cwd: string, revision: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", revision], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}
