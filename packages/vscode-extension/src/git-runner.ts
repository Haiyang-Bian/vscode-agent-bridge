import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalizeExistingPath } from "./git-path.js";

export { isPathWithin } from "./git-path.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const WRITE_GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GitRepositoryState {
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly head: string;
  readonly clean: boolean;
  readonly bare: boolean;
  readonly operation: string | null;
  readonly hasSubmodules: boolean;
}

export interface GitWorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly prunable: boolean;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export class GitRunner {
  readonly #executable: string;

  constructor(executable = "git") {
    this.#executable = executable;
  }

  async inspectRepository(candidate: string): Promise<GitRepositoryState> {
    const resolvedCandidate = await canonicalizeExistingPath(candidate);
    const repositoryRoot = await canonicalizeExistingPath(
      (await this.#read(resolvedCandidate, ["rev-parse", "--show-toplevel"])).trim(),
    );
    const [head, branch, statusOutput, bareOutput, operation, hasSubmodules] = await Promise.all([
      this.#read(repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
      this.#tryRead(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.#read(repositoryRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      this.#read(repositoryRoot, ["rev-parse", "--is-bare-repository"]),
      this.#detectOperation(repositoryRoot),
      this.#hasTrackedGitmodules(repositoryRoot),
    ]);
    return {
      repositoryRoot,
      branch: branch?.trim() || null,
      head: assertFullObjectId(head.trim()),
      clean: statusOutput.length === 0,
      bare: bareOutput.trim() === "true",
      operation,
      hasSubmodules,
    };
  }

  async listWorktrees(repositoryRoot: string): Promise<GitWorktreeEntry[]> {
    return parseWorktreePorcelain(
      await this.#read(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]),
    );
  }

  async addWorktree(
    repositoryRoot: string,
    worktreePath: string,
    branch: string,
    baseHead: string,
  ): Promise<void> {
    assertBranchName(branch);
    assertFullObjectId(baseHead);
    await this.#write(repositoryRoot, ["worktree", "add", "-b", branch, path.resolve(worktreePath), baseHead]);
  }

  async lockWorktree(repositoryRoot: string, worktreePath: string, reason: string): Promise<void> {
    await this.#write(repositoryRoot, [
      "worktree",
      "lock",
      "--reason",
      boundedMessage(reason),
      path.resolve(worktreePath),
    ]);
  }

  async unlockWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
    await this.#write(repositoryRoot, ["worktree", "unlock", path.resolve(worktreePath)]);
  }

  async removeWorktree(
    repositoryRoot: string,
    worktreePath: string,
    force: boolean,
  ): Promise<void> {
    await this.#write(repositoryRoot, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      path.resolve(worktreePath),
    ]);
  }

  async createPrivateCommit(worktreePath: string, message: string): Promise<string> {
    await this.#write(worktreePath, ["add", "--all"]);
    await this.#write(worktreePath, ["commit", "-m", boundedMessage(message)]);
    return this.head(worktreePath);
  }

  async head(cwd: string): Promise<string> {
    return assertFullObjectId((await this.#read(cwd, ["rev-parse", "--verify", "HEAD"])).trim());
  }

  async branchHead(repositoryRoot: string, branch: string): Promise<string> {
    assertBranchName(branch);
    return assertFullObjectId(
      (await this.#read(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim(),
    );
  }

  async tree(cwd: string, commit: string): Promise<string> {
    assertFullObjectId(commit);
    return assertFullObjectId((await this.#read(cwd, ["rev-parse", `${commit}^{tree}`])).trim());
  }

  async commitsBetween(cwd: string, base: string, tip = "HEAD"): Promise<string[]> {
    assertFullObjectId(base);
    if (tip !== "HEAD") {
      assertFullObjectId(tip);
    }
    const output = await this.#read(cwd, ["rev-list", "--reverse", `${base}..${tip}`]);
    return output.split(/\r?\n/u).filter(Boolean).map(assertFullObjectId);
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    assertFullObjectId(ancestor);
    assertFullObjectId(descendant);
    try {
      await this.#read(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  async hasMergeCommit(cwd: string, base: string, tip = "HEAD"): Promise<boolean> {
    assertFullObjectId(base);
    if (tip !== "HEAD") {
      assertFullObjectId(tip);
    }
    return (await this.#read(cwd, ["rev-list", "--min-parents=2", `${base}..${tip}`])).trim().length > 0;
  }

  async rebaseOnto(cwd: string, newBase: string, oldBase: string): Promise<void> {
    assertFullObjectId(newBase);
    assertFullObjectId(oldBase);
    await this.#write(cwd, ["rebase", "--onto", newBase, oldBase]);
  }

  async continueRebase(cwd: string): Promise<void> {
    await this.#write(cwd, ["rebase", "--continue"]);
  }

  async abortRebase(cwd: string): Promise<void> {
    await this.#write(cwd, ["rebase", "--abort"]);
  }

  async commitTree(cwd: string, tree: string, parent: string, message: string): Promise<string> {
    assertFullObjectId(tree);
    assertFullObjectId(parent);
    return assertFullObjectId(
      (await this.#write(cwd, ["commit-tree", tree, "-p", parent, "-m", boundedMessage(message)])).trim(),
    );
  }

  async cherryPick(cwd: string, commit: string): Promise<void> {
    assertFullObjectId(commit);
    await this.#write(cwd, ["cherry-pick", commit]);
  }

  async abortCherryPick(cwd: string): Promise<void> {
    await this.#write(cwd, ["cherry-pick", "--abort"]);
  }

  async commitParents(cwd: string, commit: string): Promise<string[]> {
    assertFullObjectId(commit);
    const parts = (await this.#read(cwd, ["rev-list", "--parents", "-n", "1", commit]))
      .trim()
      .split(/\s+/u);
    if (parts.shift() !== commit) {
      throw new Error("Git returned an unexpected commit record.");
    }
    return parts.map(assertFullObjectId);
  }

  async diffSummary(cwd: string, from: string, to: string): Promise<{ files: string[]; stat: string }> {
    assertFullObjectId(from);
    assertFullObjectId(to);
    const [fileOutput, stat] = await Promise.all([
      this.#read(cwd, ["diff", "--name-only", "-z", from, to, "--"]),
      this.#read(cwd, ["diff", "--stat", from, to, "--"]),
    ]);
    return {
      files: fileOutput.split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right)),
      stat: stat.trim(),
    };
  }

  async branchUpstream(repositoryRoot: string, branch: string): Promise<string | null> {
    assertBranchName(branch);
    return (
      await this.#read(repositoryRoot, [
        "for-each-ref",
        "--format=%(upstream)",
        `refs/heads/${branch}`,
      ])
    ).trim() || null;
  }

  async deleteBranchRef(repositoryRoot: string, branch: string, expectedHead: string): Promise<void> {
    assertBranchName(branch);
    assertFullObjectId(expectedHead);
    await this.#write(repositoryRoot, ["update-ref", "-d", `refs/heads/${branch}`, expectedHead]);
  }

  async #detectOperation(repositoryRoot: string): Promise<string | null> {
    const markers: Array<[string, string]> = [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REBASE_HEAD", "rebase"],
      ["BISECT_LOG", "bisect"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
    ];
    for (const [marker, operation] of markers) {
      const rawPath = (await this.#read(repositoryRoot, ["rev-parse", "--git-path", marker])).trim();
      const markerPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repositoryRoot, rawPath);
      try {
        await stat(markerPath);
        return operation;
      } catch {
        // Continue to the next fixed operation marker.
      }
    }
    return null;
  }

  async #hasTrackedGitmodules(repositoryRoot: string): Promise<boolean> {
    try {
      await this.#read(repositoryRoot, ["ls-files", "--error-unmatch", "--", ".gitmodules"]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  async #tryRead(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      return await this.#read(cwd, args);
    } catch {
      return null;
    }
  }

  #read(cwd: string, args: readonly string[]): Promise<string> {
    return this.#execute(cwd, args, DEFAULT_GIT_TIMEOUT_MS);
  }

  #write(cwd: string, args: readonly string[]): Promise<string> {
    return this.#execute(cwd, args, WRITE_GIT_TIMEOUT_MS);
  }

  async #execute(cwd: string, args: readonly string[], timeout: number): Promise<string> {
    const resolvedCwd = path.resolve(cwd);
    try {
      const { stdout } = await execFileAsync(this.#executable, [...args], {
        cwd: resolvedCwd,
        encoding: "utf8",
        timeout,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      const exitCode = typeof failure.code === "number" ? failure.code : null;
      throw new GitCommandError(
        `Git ${args[0] ?? "operation"} failed.`,
        exitCode,
        boundedOutput(failure.stdout),
        boundedOutput(failure.stderr),
      );
    }
  }
}

export function assertBranchName(branch: string): string {
  if (
    branch.length === 0 ||
    branch.length > 240 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20~^:?*\\[\]]/u.test(branch)
  ) {
    throw new Error("Git branch name is invalid.");
  }
  return branch;
}

export function assertFullObjectId(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error("Git object ID must be a full hexadecimal hash.");
  }
  return value;
}

function parseWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const records = output.split("\0\0").map((record) => record.split("\0").filter(Boolean));
  const entries: GitWorktreeEntry[] = [];
  for (const fields of records) {
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!worktree) {
      continue;
    }
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? null;
    const branchRef = fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null;
    const locked = fields.find((field) => field === "locked" || field.startsWith("locked "));
    entries.push({
      path: path.resolve(worktree),
      head: head ? assertFullObjectId(head) : null,
      branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
      detached: fields.includes("detached"),
      locked: locked !== undefined,
      lockReason: locked?.startsWith("locked ") ? locked.slice(7) : null,
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
    });
  }
  return entries;
}

function boundedMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0 || normalized.length > 2_000 || normalized.includes("\0")) {
    throw new Error("Git message must contain 1 to 2,000 characters.");
  }
  return normalized;
}

function boundedOutput(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 8_192) : "";
}
