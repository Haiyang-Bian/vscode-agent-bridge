import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { startHttpE2EService } from "./lib/http-e2e-service.ts";
import { cleanupE2EEnvironment, createE2EEnvironment, createE2EEnvironmentVariables, prepareFixtureWorkspace, stageDevelopmentExtension } from "./lib/e2e-runner.ts";
import { HttpE2EClient } from "../packages/vscode-extension/test/e2e/http-client.ts";

const repository = path.resolve(import.meta.dir, "..");
const extensionRoot = path.join(repository, "packages/vscode-extension");
const environment = await createE2EEnvironment("bridge-http-window-");
const secondary = path.join(environment.root, "secondary-workspace");
let child: Bun.Subprocess | undefined;
let service: Awaited<ReturnType<typeof startHttpE2EService>> | undefined;
let client: HttpE2EClient | undefined;
try {
  await prepareFixtureWorkspace(path.join(extensionRoot, "test/fixtures/typescript-workspace"), environment.workspace);
  await mkdir(secondary);
  await stageDevelopmentExtension(extensionRoot, environment.stagedExtension);
  const executable = process.env.VSCODE_AGENT_BRIDGE_TEST_EXE;
  service = await startHttpE2EService(environment, executable);
  Object.assign(process.env, service.env);
  client = new HttpE2EClient(); await client.connect();
  const pid = (await client.health()).pid;
  assert.deepEqual(await client.call("vscode_list_instances"), { instances: [] });
  const vscode = await downloadAndUnzipVSCode({ version: "stable", cachePath: path.join(extensionRoot, ".vscode-test") });
  child = Bun.spawn([vscode, environment.workspace, `--user-data-dir=${environment.userData}`, `--extensions-dir=${environment.extensions}`,
    `--extensionDevelopmentPath=${environment.stagedExtension}`, `--extensionDevelopmentPath=${path.join(extensionRoot, "test/http-lifecycle-harness")}`,
    "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    env: createE2EEnvironmentVariables(environment, ["lifecycle"], { ...service.env,
      VSCODE_AGENT_BRIDGE_HTTP_LIFECYCLE_ROOT: environment.root, VSCODE_AGENT_BRIDGE_HTTP_SECONDARY: secondary }),
  });
  const reload = await marker("window-reloaded.json") as { beforeInstanceId: string; afterInstanceId: string; initializing: boolean };
  await marker("secondary-ready.json");
  const instances = await client.call<{ instances: Array<{ instanceId: string }> }>("vscode_list_instances");
  assert.equal(instances.instances.length, 2);
  assert.notEqual(reload.beforeInstanceId, reload.afterInstanceId);
  assert.equal((await client.health()).pid, pid);
  const ambiguous = await client.request("tools/call", { name: "vscode_get_editor_context", arguments: {} });
  assert.equal(ambiguous.isError, true); assert.ok(JSON.stringify(ambiguous.content).includes("AMBIGUOUS_INSTANCE"));
  for (const instance of instances.instances) {
    const result = await client.request("tools/call", { name: "vscode_get_editor_context", arguments: { instanceId: instance.instanceId } });
    assert.ok(!JSON.stringify(result.content).includes("AMBIGUOUS_INSTANCE"));
  }
  await writeFile(path.join(environment.root, "close-windows"), "close test windows");
  await wait(async () => child!.exitCode !== null);
  await wait(async () => (await client!.call<{ instances: unknown[] }>("vscode_list_instances")).instances.length === 0);
  assert.equal((await client.health()).pid, pid);
  const evidence = { daemonPid: pid, noIdeReady: true, initializingObserved: reload.initializing, realWindowReload: true, multipleWindows: 2, explicitRouting: true, windowExitReady: true };
  assert.equal(evidence.initializingObserved, true);
  await mkdir(path.join(repository, "artifacts/phase1-evidence"), { recursive: true });
  await writeFile(path.join(repository, "artifacts/phase1-evidence/http-window-lifecycle.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally {
  await writeFile(path.join(environment.root, "close-windows"), "cleanup test windows").catch(() => undefined);
  if (child?.exitCode === null) {
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
  await client?.close();
  try { await service?.close(); } finally { await cleanupE2EEnvironment(environment); }
}

async function marker(name: string): Promise<unknown> {
  return wait(async () => {
    try { const failed = JSON.parse(await readFile(path.join(environment.root, "lifecycle-failed.json"), "utf8")); throw new Error(`The lifecycle harness failed: ${failed.message}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { return JSON.parse(await readFile(path.join(environment.root, name), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  });
}
async function wait<T>(operation: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await Bun.sleep(100); }
  throw new Error("The isolated HTTP window lifecycle check timed out.");
}
