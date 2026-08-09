import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "bun:test";

import { ReadOnlyGitBaseline } from "../src/git-baseline.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("read-only Git baseline", () => {
  test("discovers the repository and dirty text paths", async () => {
    const root = await createRepository();
    await writeFile(path.join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");
    const inspected = await ReadOnlyGitBaseline.inspect(root);
    expect(inspected).not.toBeNull();
    expect(inspected?.baseline.branch).toBe("main");
    expect(inspected?.baseline.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(inspected?.baseline.dirtyPaths).toEqual(["tracked.txt", "untracked.txt"]);
    expect(await inspected?.git.readHeadText("tracked.txt")).toBe("base\n");
    expect(await inspected?.git.isTracked("tracked.txt")).toBe(true);
    expect(await inspected?.git.isTracked("untracked.txt")).toBe(false);
  });

  test("rejects paths outside the repository", async () => {
    const root = await createRepository();
    const inspected = await ReadOnlyGitBaseline.inspect(root);
    expect(() => inspected?.git.resolvePath("../outside.txt")).toThrow();
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-git-"));
  directories.push(root);
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Bridge Test"]);
  await git(root, ["config", "user.email", "bridge@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n", "utf8");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}
