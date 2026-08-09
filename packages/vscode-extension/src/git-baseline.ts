import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GitBaseline {
  readonly repositoryRoot: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly dirtyPaths: readonly string[];
}

export class ReadOnlyGitBaseline {
  readonly repositoryRoot: string;
  readonly #gitExecutable: string;

  private constructor(repositoryRoot: string, gitExecutable: string) {
    this.repositoryRoot = repositoryRoot;
    this.#gitExecutable = gitExecutable;
  }

  static async inspect(
    candidateRoot: string,
    gitExecutable = "git",
  ): Promise<{ git: ReadOnlyGitBaseline; baseline: GitBaseline } | null> {
    const resolvedCandidate = path.resolve(candidateRoot);
    let repositoryRoot: string;
    try {
      repositoryRoot = path.resolve(
        (
          await runGit(gitExecutable, resolvedCandidate, ["rev-parse", "--show-toplevel"])
        ).trim(),
      );
    } catch {
      return null;
    }
    if (!isWithin(repositoryRoot, resolvedCandidate) && !isWithin(resolvedCandidate, repositoryRoot)) {
      return null;
    }

    const git = new ReadOnlyGitBaseline(repositoryRoot, gitExecutable);
    const [head, branch, working, staged, untracked] = await Promise.all([
      git.tryRead(["rev-parse", "--verify", "HEAD"]),
      git.tryRead(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git.readNullSeparated(["diff", "--name-only", "-z"]),
      git.readNullSeparated(["diff", "--cached", "--name-only", "-z"]),
      git.readNullSeparated(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const dirtyPaths = [...new Set([...working, ...staged, ...untracked])]
      .map(normalizeGitPath)
      .filter((relativePath) => isSafeRelativePath(relativePath))
      .sort((left, right) => left.localeCompare(right));

    return {
      git,
      baseline: {
        repositoryRoot,
        head: head?.trim() || null,
        branch: branch?.trim() || null,
        dirtyPaths,
      },
    };
  }

  async getHead(): Promise<string | null> {
    return (await this.tryRead(["rev-parse", "--verify", "HEAD"]))?.trim() || null;
  }

  async changedPaths(fromRevision: string, toRevision: string): Promise<string[]> {
    const revisions = [fromRevision, toRevision];
    if (!revisions.every((revision) => /^[0-9a-f]{40,64}$/u.test(revision))) {
      throw new Error("Git revisions must be full object IDs.");
    }
    return (await this.readNullSeparated(["diff", "--name-only", "-z", ...revisions, "--"]))
      .map(normalizeGitPath)
      .filter((relativePath) => isSafeRelativePath(relativePath))
      .sort((left, right) => left.localeCompare(right));
  }

  async readHeadText(relativePath: string, head = "HEAD"): Promise<string | null> {
    this.resolvePath(relativePath);
    try {
      return await this.read(["show", `${head}:${toGitPath(relativePath)}`]);
    } catch {
      return null;
    }
  }

  async isTracked(relativePath: string): Promise<boolean> {
    this.resolvePath(relativePath);
    try {
      await this.read(["ls-files", "--error-unmatch", "--", toGitPath(relativePath)]);
      return true;
    } catch {
      return false;
    }
  }

  async dirtyPaths(): Promise<string[]> {
    const [working, staged, untracked] = await Promise.all([
      this.readNullSeparated(["diff", "--name-only", "-z"]),
      this.readNullSeparated(["diff", "--cached", "--name-only", "-z"]),
      this.readNullSeparated(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return [...new Set([...working, ...staged, ...untracked])]
      .map(normalizeGitPath)
      .filter((relativePath) => isSafeRelativePath(relativePath))
      .sort((left, right) => left.localeCompare(right));
  }

  relativePath(absolutePath: string): string | null {
    const relative = path.relative(this.repositoryRoot, path.resolve(absolutePath));
    return isSafeRelativePath(relative) ? normalizeGitPath(relative) : null;
  }

  resolvePath(relativePath: string): string {
    if (!isSafeRelativePath(relativePath)) {
      throw new Error("Git path escapes the selected repository.");
    }
    const resolved = path.resolve(this.repositoryRoot, relativePath);
    if (!isWithin(this.repositoryRoot, resolved)) {
      throw new Error("Git path escapes the selected repository.");
    }
    return resolved;
  }

  private async read(args: readonly string[]): Promise<string> {
    return runGit(this.#gitExecutable, this.repositoryRoot, args);
  }

  private async tryRead(args: readonly string[]): Promise<string | null> {
    try {
      return await this.read(args);
    } catch {
      return null;
    }
  }

  private async readNullSeparated(args: readonly string[]): Promise<string[]> {
    const output = await this.read(args);
    return output.split("\0").filter(Boolean);
  }
}

async function runGit(
  executable: string,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(executable, ["-C", cwd, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  return stdout;
}

function isSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== "." &&
    !path.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !relativePath.includes("\0")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || isSafeRelativePath(relative);
}

function normalizeGitPath(relativePath: string): string {
  return relativePath.replaceAll("/", path.sep);
}

function toGitPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}
