import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceInstaller, prepareExecutable } from "../packages/mcp-server/src/service-installer.ts";
import { resolveServicePaths, readIdentity, readOptional } from "../packages/mcp-server/src/service-state.ts";
import { controlRequest, stopVerifiedService, waitForReady } from "../packages/mcp-server/src/service-control.ts";
import { isCurrentLoginTask } from "../packages/mcp-server/src/service-scheduler.ts";
import { BRIDGE_RELEASE_VERSION } from "@vscode-agent-bridge/protocol";

const repository = path.resolve(import.meta.dir, "..");
const sourceExecutable = path.join(repository, "packages/vscode-extension/resources/bin/vscode-agent-bridge-mcp.exe");
const temporaryParent = await realpath(os.tmpdir());
const root = await realpath(await mkdtemp(path.join(temporaryParent, "bridge-http-install-")));
assert.ok(root.startsWith(temporaryParent + path.sep) && path.basename(root).startsWith("bridge-http-install-"));
const paths = await resolveServicePaths(path.join(root, "service"));
const configPath = path.join(root, "codex", "config.toml");
const registryDirectory = path.join(root, "registry");
const installer = new ServiceInstaller(paths);
const evidence: Record<string, unknown> = { version: BRIDGE_RELEASE_VERSION, startedAt: new Date().toISOString() };
try {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '# preserved test configuration\nmodel = "test"\n');
  const first = await installer.install({ sourceExecutable, configPath, registryDirectory });
  const identity = await readIdentity(paths);
  const installation = JSON.parse((await readOptional(paths.installation))!);
  const xml = (await installer.scheduler.query())!;
  assert.ok(isCurrentLoginTask(xml, paths, installation.executablePath, registryDirectory), "actual Task Scheduler XML must retain every lifecycle setting");
  evidence.firstPid = first.status.pid;
  evidence.loginTaskVerified = true;
  const second = await installer.install({ sourceExecutable, configPath, registryDirectory });
  assert.equal(second.status.bootId, first.status.bootId, "idempotent install must keep the daemon");
  assert.equal(second.changed, false);
  evidence.idempotent = true;

  const originalConfig = await readFile(configPath, "utf8");
  const originalIdentity = await readFile(paths.identity, "utf8");
  let failHealthOnce = true;
  let rejectedBoot: string | undefined;
  const failingUpgrade = new ServiceInstaller(paths, {
    prepare: async (servicePaths, source) => {
      const prepared = await prepareExecutable(servicePaths, source);
      const candidatePath = path.join(path.dirname(prepared.executablePath), "rollback-candidate.exe");
      await copyFile(prepared.executablePath, candidatePath);
      return { ...prepared, executablePath: candidatePath, changed: true };
    },
    ready: async (...args) => {
      const ready = await waitForReady(...args);
      if (failHealthOnce) { failHealthOnce = false; rejectedBoot = ready.bootId; throw new Error("Injected post-start acceptance failure"); }
      return ready;
    },
  });
  await assert.rejects(failingUpgrade.install({ sourceExecutable, configPath, registryDirectory }), /Injected post-start acceptance failure/u);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal(await readFile(paths.identity, "utf8"), originalIdentity);
  const restored = await waitForReady(paths, identity);
  assert.notEqual(restored.bootId, rejectedBoot);
  assert.ok(isCurrentLoginTask((await installer.scheduler.query())!, paths, installation.executablePath, registryDirectory));
  assert.equal(await readOptional(paths.transaction), null);
  evidence.rollbackVerified = true;
  evidence.restoredPid = restored.pid;

  await installer.stop();
  const restarted = await installer.start();
  assert.notEqual(restarted.bootId, restored.bootId);
  evidence.managedRestartVerified = true;
  const removal = await installer.uninstall();
  assert.equal(removal.changed, true);
  assert.equal(await installer.scheduler.query(), null);
  assert.equal(await readOptional(paths.installation), null);
  assert.ok((await readFile(configPath, "utf8")).includes('model = "test"'));
  assert.ok(!(await readFile(configPath, "utf8")).includes("mcp_servers.vscode_agent_bridge"));
  assert.ok((await readFile(installation.executablePath)).length > 0);
  evidence.uninstallVerified = true;
  console.log(JSON.stringify(evidence));
  await mkdir(path.join(repository, "artifacts/phase1-evidence"), { recursive: true });
  await writeFile(path.join(repository, "artifacts/phase1-evidence/http-service-install.json"), JSON.stringify(evidence, null, 2) + "\n");
} finally {
  if (await readOptional(paths.identity)) {
    const identity = await readIdentity(paths);
    const current = await installer.current(identity);
    if (current) await stopVerifiedService(paths, identity, current);
  }
  await installer.scheduler.remove();
  await rm(root, { recursive: true, force: true });
}
