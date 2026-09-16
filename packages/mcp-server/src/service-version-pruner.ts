import { readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { ServiceInstallationSchema, type ServiceInstallation } from "@vscode-agent-bridge/protocol";
import { readOptional, type ServicePaths } from "./service-state.js";

const EXECUTABLE_NAME = "vscode-agent-bridge-mcp.exe";
const HASH_DIRECTORY = /^[a-f0-9]{16}$/u;

/**
 * Removes unreferenced version/hash directories after a successful install.
 * The current installation, its verified rollback, the login task and an
 * interrupted transaction are all treated as live references.
 */
export async function pruneServiceVersions(
  paths: ServicePaths,
  installation: ServiceInstallation,
  loginTaskXml: string | null,
): Promise<void> {
  const versionsDirectory = path.resolve(paths.directory, "versions");
  const protectedExecutables = new Set<string>();
  protect(protectedExecutables, installation.executablePath);
  protect(protectedExecutables, installation.rollback?.executablePath);
  protect(protectedExecutables, executableFromTask(loginTaskXml));

  const transactionRaw = await readOptional(paths.transaction);
  if (transactionRaw) addTransactionReferences(protectedExecutables, transactionRaw);

  let versionsReal: string;
  let versions;
  try {
    versionsReal = await realpath(versionsDirectory);
    versions = await readdir(versionsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const versionEntry of versions) {
    if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) continue;
    const versionDirectory = path.join(versionsDirectory, versionEntry.name);
    const hashes = await readdir(versionDirectory, { withFileTypes: true });
    for (const hashEntry of hashes) {
      if (!hashEntry.isDirectory() || hashEntry.isSymbolicLink() || !HASH_DIRECTORY.test(hashEntry.name)) continue;
      const hashDirectory = path.join(versionDirectory, hashEntry.name);
      const executable = path.join(hashDirectory, EXECUTABLE_NAME);
      if (protectedExecutables.has(normalize(executable))) continue;
      const resolved = await realpath(hashDirectory);
      assertInside(versionsReal, resolved);
      await rm(resolved, { recursive: true, force: true });
    }
    if ((await readdir(versionDirectory)).length === 0) {
      const resolved = await realpath(versionDirectory);
      assertInside(versionsReal, resolved);
      await rmdir(resolved);
    }
  }
}

function addTransactionReferences(protectedExecutables: Set<string>, raw: string): void {
  try {
    const transaction = JSON.parse(raw) as { previousInstallation?: unknown; previousTask?: unknown };
    if (typeof transaction.previousInstallation === "string") {
      const installation = ServiceInstallationSchema.parse(JSON.parse(transaction.previousInstallation));
      protect(protectedExecutables, installation.executablePath);
      protect(protectedExecutables, installation.rollback?.executablePath);
    }
    if (typeof transaction.previousTask === "string") {
      protect(protectedExecutables, executableFromTask(transaction.previousTask));
    }
  } catch {
    // Recovery owns malformed transaction handling. Cleanup stays fail-safe by
    // retaining everything when the active record cannot be interpreted.
    throw new Error("The active service transaction could not be inspected for version cleanup.");
  }
}

function executableFromTask(xml: string | null): string | undefined {
  const encoded = xml?.match(/<Command>([^<]*)<\/Command>/u)?.[1];
  return encoded ? unescapeXml(encoded) : undefined;
}

function protect(targets: Set<string>, executable: string | null | undefined): void {
  if (executable) targets.add(normalize(executable));
}

function normalize(target: string): string {
  return path.resolve(target).toLowerCase();
}

function assertInside(parent: string, target: string): void {
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to prune a path outside the managed versions directory.");
  }
}

function unescapeXml(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
