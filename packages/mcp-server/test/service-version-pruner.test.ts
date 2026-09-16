import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServiceInstallation } from "@vscode-agent-bridge/protocol";
import { createLoginTaskXml } from "../src/service-scheduler.js";
import { pruneServiceVersions } from "../src/service-version-pruner.js";
import type { ServicePaths } from "../src/service-state.js";

let root: string;
let paths: ServicePaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-prune-test-"));
  paths = {
    directory: root,
    identity: path.join(root, "service-identity.json"),
    installation: path.join(root, "service-installation.json"),
    transaction: path.join(root, "service-transaction.json"),
    endpoint: String.raw`\\.\pipe\test-service`,
    installEndpoint: String.raw`\\.\pipe\test-install`,
    taskName: "VSCodeAgentBridge-test",
    serviceId: "a".repeat(32),
    userSid: "S-1-5-21-1-2-3-1001",
  };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function candidate(version: string, hashPrefix: string): Promise<string> {
  const executable = path.join(root, "versions", version, hashPrefix, "vscode-agent-bridge-mcp.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, `${version}-${hashPrefix}`);
  return executable;
}

function installation(current: string, rollback: string | null): ServiceInstallation {
  return {
    contractVersion: 1,
    version: "0.14.0",
    executablePath: current,
    executableSha256: "1".repeat(64),
    rollback: rollback ? { version: "0.13.0", executablePath: rollback, executableSha256: "2".repeat(64) } : null,
    taskName: paths.taskName,
    codexConfigPath: null,
    registryDirectory: null,
    installedAt: new Date().toISOString(),
  };
}

describe("installed service version pruning", () => {
  test("keeps the current executable and one rollback while removing stale hash directories", async () => {
    const current = await candidate("0.14.0", "1111111111111111");
    const rollback = await candidate("0.13.0", "2222222222222222");
    await candidate("0.13.0", "3333333333333333");
    await candidate("0.12.0", "4444444444444444");

    await pruneServiceVersions(paths, installation(current, rollback), createLoginTaskXml(paths, current));

    expect(await readFile(current, "utf8")).toContain("0.14.0");
    expect(await readFile(rollback, "utf8")).toContain("0.13.0");
    expect(await readdir(path.join(root, "versions", "0.13.0"))).toEqual(["2222222222222222"]);
    expect(await readdir(path.join(root, "versions"))).not.toContain("0.12.0");
  });

  test("also protects executables referenced by the login task and an active transaction", async () => {
    const current = await candidate("0.14.0", "1111111111111111");
    const taskExecutable = await candidate("0.13.0", "2222222222222222");
    const transactionExecutable = await candidate("0.13.0", "3333333333333333");
    const previous = installation(transactionExecutable, null);
    await writeFile(paths.transaction, JSON.stringify({
      previousInstallation: JSON.stringify(previous),
      previousTask: null,
    }));

    await pruneServiceVersions(paths, installation(current, null), createLoginTaskXml(paths, taskExecutable));

    expect(await readFile(taskExecutable, "utf8")).toContain("2222222222222222");
    expect(await readFile(transactionExecutable, "utf8")).toContain("3333333333333333");
  });

  test("fails closed when an active transaction cannot be inspected", async () => {
    const current = await candidate("0.14.0", "1111111111111111");
    const stale = await candidate("0.13.0", "2222222222222222");
    await writeFile(paths.transaction, "not-json");

    await expect(pruneServiceVersions(paths, installation(current, null), null)).rejects.toThrow("could not be inspected");
    expect(await readFile(stale, "utf8")).toContain("2222222222222222");
  });
});
