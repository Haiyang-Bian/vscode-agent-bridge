import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BRIDGE_RELEASE_VERSION, BRIDGE_PROTOCOL_VERSION, SERVICE_DIRECTORY_ENV, type ServiceStatus } from "@vscode-agent-bridge/protocol";
import { ServiceInstaller } from "../src/service-installer.js";
import { resolveServicePaths, readIdentity, readOptional, writePrivateJson, type ServicePaths } from "../src/service-state.js";
import { isCurrentLoginTask, type ServiceScheduler } from "../src/service-scheduler.js";
import { writeConfigChange } from "../src/service-config.js";

let root: string, paths: ServicePaths, configPath: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-install-test-"));
  configPath = path.join(root, "config.toml");
  const previous = process.env[SERVICE_DIRECTORY_ENV]; process.env[SERVICE_DIRECTORY_ENV] = root;
  try { paths = await resolveServicePaths(); }
  finally { if (previous === undefined) delete process.env[SERVICE_DIRECTORY_ENV]; else process.env[SERVICE_DIRECTORY_ENV] = previous; }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture() {
  let task: string | null = null, current: ServiceStatus | null = null;
  let generation = 0, rejectReady = false;
  const events: string[] = [];
  const scheduler: ServiceScheduler = {
    query: async () => task,
    register: async xml => { events.push("register"); task = xml; },
    run: async () => { events.push("run"); },
    remove: async () => { events.push("remove"); task = null; },
  };
  const installer = new ServiceInstaller(paths, {
    scheduler,
    prepare: async () => ({ executablePath: path.join(root, `v${generation}`, "bridge.exe"), sha256: String(generation).repeat(64), changed: false }),
    current: async () => { if (!current) throw new Error("Not running"); return current; },
    stop: async (_paths, _identity, status) => { expect(status.bootId).toBe(current!.bootId); events.push("stop"); current = null; },
    ready: async (_paths, identity) => {
      events.push("ready");
      if (rejectReady) { rejectReady = false; throw new Error("Injected startup failure"); }
      current ??= { contractVersion: 1, serviceId: paths.serviceId, pid: 999999, bootId: randomUUID(), state: "ready", port: identity.port,
        version: BRIDGE_RELEASE_VERSION, protocolVersion: BRIDGE_PROTOCOL_VERSION, sessions: 0, activeRequests: 0, startedAt: new Date().toISOString() };
      return current;
    },
  });
  return { installer, events, scheduler, get current() { return current; }, get task() { return task; },
    upgrade() { generation++; }, failStart() { rejectReady = true; } };
}

describe("Transactional service installation", () => {
  test("migrates only the managed STDIO block, protects backups, and installs idempotently", async () => {
    const old = '# keep\nmodel = "test"\n# vscode-agent-bridge:begin\n[mcp_servers.vscode_agent_bridge]\ncommand = "C:/old.exe"\nargs = []\n# vscode-agent-bridge:end\n';
    await writeFile(configPath, old);
    const f = fixture();
    const first = await f.installer.install({ sourceExecutable: "source.exe", configPath });
    const identity = await readIdentity(paths);
    const config = await readFile(configPath, "utf8");
    expect(config).toStartWith('# keep\nmodel = "test"');
    expect(config).toContain(`http://127.0.0.1:${identity.port}/mcp`);
    expect(config).toContain(identity.mcpToken);
    expect(config).not.toContain(identity.managementToken);
    expect(config).not.toContain("command =");
    expect(config).not.toContain("args =");
    expect(await readFile(first.backupPath!, "utf8")).toBe(old);
    expect(f.events).toEqual(["register", "run", "ready"]);
    const second = await f.installer.install({ sourceExecutable: "source.exe", configPath });
    expect(second.changed).toBe(false);
    expect(second.status.bootId).toBe(first.status.bootId);
    expect(f.events).toEqual(["register", "run", "ready", "ready"]);
    expect(await readOptional(paths.transaction)).toBeNull();
    expect((await readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
    expect(isCurrentLoginTask(f.task!, paths, path.join(root, "v0", "bridge.exe"))).toBe(true);
    expect(isCurrentLoginTask(f.task!.replace("IgnoreNew", "Parallel"), paths, path.join(root, "v0", "bridge.exe"))).toBe(false);
  });

  test("a failed first install restores the original config and removes only its new task/identity", async () => {
    const old = 'model = "keep"\n'; await writeFile(configPath, old);
    const f = fixture(); f.failStart();
    await expect(f.installer.install({ sourceExecutable: "source.exe", configPath })).rejects.toThrow("Injected startup failure");
    expect(await readFile(configPath, "utf8")).toBe(old);
    expect(f.task).toBeNull(); expect(await readOptional(paths.identity)).toBeNull();
    expect(await readOptional(paths.installation)).toBeNull(); expect(await readOptional(paths.transaction)).toBeNull();
  });

  test("failed upgrades restore the prior task, credentials, config and running service", async () => {
    const f = fixture(); await f.installer.install({ sourceExecutable: "source.exe", configPath });
    const oldTask = f.task, oldIdentity = await readFile(paths.identity, "utf8"), oldConfig = await readFile(configPath, "utf8");
    const oldInstallation = await readFile(paths.installation, "utf8");
    f.upgrade(); f.failStart();
    await expect(f.installer.install({ sourceExecutable: "next.exe", configPath })).rejects.toThrow("Injected startup failure");
    expect(f.task).toBe(oldTask); expect(f.current?.state).toBe("ready");
    expect(await readFile(paths.identity, "utf8")).toBe(oldIdentity);
    expect(await readFile(configPath, "utf8")).toBe(oldConfig);
    expect(await readFile(paths.installation, "utf8")).toBe(oldInstallation);
    expect(f.events.slice(-6)).toEqual(["stop", "register", "run", "ready", "register", "run"].concat("ready").slice(-6));
  });

  test("rejects unmanaged and concurrent configuration edits without overwriting them", async () => {
    const unmanaged = '[mcp_servers.vscode_agent_bridge]\ncommand = "custom"\n'; await writeFile(configPath, unmanaged);
    const f = fixture();
    await expect(f.installer.install({ sourceExecutable: "source.exe", configPath })).rejects.toMatchObject({ code: "SERVICE_INSTALL_CONFLICT" });
    expect(f.events).toEqual([]); expect(await readFile(configPath, "utf8")).toBe(unmanaged);
    await expect(writeConfigChange(configPath, 'different', 'replacement', paths.userSid)).rejects.toMatchObject({ code: "SERVICE_INSTALL_CONFLICT" });
    expect(await readFile(configPath, "utf8")).toBe(unmanaged);
  });

  test("recovers an interrupted transaction before further management and uninstalls without deleting version state", async () => {
    const f = fixture(); const original = 'model = "keep"\n'; await writeFile(configPath, original);
    const result = await f.installer.install({ sourceExecutable: "source.exe", configPath });
    await writePrivateJson(paths.transaction, { contractVersion: 1, serviceId: paths.serviceId, operation: "install", previousIdentity: null,
      previousInstallation: null, previousTask: null, previousStatus: null, configPath, previousConfig: original,
      publishedConfig: await readFile(configPath, "utf8"), candidateVersion: BRIDGE_RELEASE_VERSION, candidateBootId: result.status.bootId }, paths.userSid);
    await f.installer.exclusive(async () => {});
    expect(f.current).toBeNull(); expect(await readFile(configPath, "utf8")).toBe(original);
    await f.installer.install({ sourceExecutable: "source.exe", configPath });
    const identity = await readFile(paths.identity, "utf8");
    const removal = await f.installer.uninstall();
    expect(removal.changed).toBe(true); expect(f.task).toBeNull(); expect(f.current).toBeNull();
    expect(await readFile(paths.identity, "utf8")).toBe(identity);
    expect(await readOptional(paths.installation)).toBeNull();
    expect(await readFile(configPath, "utf8")).toContain(original);
  });
});
