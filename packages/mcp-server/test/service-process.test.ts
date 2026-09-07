import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SERVICE_DIRECTORY_ENV, MCP_TOOL_NAMES, BRIDGE_RELEASE_VERSION, BRIDGE_PROTOCOL_VERSION, type ServiceIdentity } from "@vscode-agent-bridge/protocol";
import { ensurePrivateDirectory, newServiceIdentity, resolveServicePaths, writePrivateJson, type ServicePaths } from "../src/service-state.js";
import { controlRequest, stopVerifiedService, waitForReady } from "../src/service-control.js";
import { WindowsControlPipe, hardenPrivatePath } from "../src/windows-service-native.js";

let root: string, paths: ServicePaths, identity: ServiceIdentity;
const children: Bun.Subprocess[] = [];
const executable = process.env.VSCODE_AGENT_BRIDGE_TEST_EXE;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-service-process-"));
  const previous = process.env[SERVICE_DIRECTORY_ENV];
  process.env[SERVICE_DIRECTORY_ENV] = root;
  try { paths = await resolveServicePaths(); }
  finally { if (previous === undefined) delete process.env[SERVICE_DIRECTORY_ENV]; else process.env[SERVICE_DIRECTORY_ENV] = previous; }
  const allocator = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  identity = newServiceIdentity(paths, allocator.port!);
  await allocator.stop(true);
  await ensurePrivateDirectory(root, paths.userSid);
  await writePrivateJson(paths.identity, identity, paths.userSid);
});
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(); await child.exited; }
  await rm(root, { recursive: true, force: true });
});
function launch(extra: string[] = ["serve"]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const command = executable ? [executable] : [process.execPath, path.resolve(import.meta.dir, "../src/index.ts")];
  const child = Bun.spawn([...command, ...extra, "--service-dir", root, "--registry-dir", path.join(root, "registry")], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  children.push(child);
  return child;
}
async function connect() {
  const client = new Client({ name: "daemon-process-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${identity.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${identity.mcpToken}` } } });
  await client.connect(transport as Transport);
  return { client, transport };
}

describe("HTTP daemon process boundary", () => {
  test("20 concurrent launch attempts share one authenticated daemon and flush usage on stop", async () => {
    const attempts = Array.from({ length: 20 }, () => launch());
    const status = await waitForReady(paths, identity);
    expect(status).toMatchObject({ version: BRIDGE_RELEASE_VERSION, protocolVersion: BRIDGE_PROTOCOL_VERSION, state: "ready" });
    const owner = attempts.find(child => child.pid === status.pid)!;
    expect(owner).toBeDefined();
    await expect(controlRequest(paths, { ...identity, managementToken: "0".repeat(64) }, "status")).rejects.toMatchObject({ code: "SERVICE_IDENTITY_UNVERIFIED" });
    for (const child of attempts.filter(child => child !== owner)) {
      expect(await child.exited).toBe(0);
      const output = await new Response(child.stdout).text();
      expect(JSON.parse(output).pid).toBe(owner.pid);
      expect(await new Response(child.stderr).text()).toBe("");
    }
    expect(attempts.filter(child => child.exitCode === null).length).toBe(1);
    const a = await connect(), b = await connect();
    try {
      expect((await a.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      const missing = await b.client.callTool({ name: "vscode_get_editor_context", arguments: {} });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("NO_VSCODE_INSTANCE");
      await a.transport.terminateSession();
      expect((await b.client.callTool({ name: "vscode_list_instances", arguments: {} })).structuredContent).toEqual({ instances: [] });
      expect((await controlRequest(paths, identity, "status")).pid).toBe(owner.pid);
    } finally { await a.client.close(); await b.client.close(); }
    await stopVerifiedService(paths, identity, status);
    expect(await owner.exited).toBe(0);
    const insights = path.join(root, "registry", "insights");
    const files = await readdir(insights);
    expect(files.length).toBeGreaterThan(0);
    expect((await Promise.all(files.map(file => readFile(path.join(insights, file), "utf8")))).join("\n")).toContain("vscode_list_instances");
  }, 30_000);

  test("process crash releases singleton ownership and a new boot can reuse the persisted port", async () => {
    const first = launch();
    const old = await waitForReady(paths, identity);
    first.kill(); await first.exited;
    const second = launch();
    const current = await waitForReady(paths, identity);
    expect(current.pid).toBe(second.pid);
    expect(current.bootId).not.toBe(old.bootId);
    expect(current.port).toBe(old.port);
    await stopVerifiedService(paths, identity, current);
  }, 20_000);

  test("port conflicts fail without moving the service or exposing credentials", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: identity.port, fetch: () => new Response(null) });
    try {
      const child = launch();
      expect(await child.exited).toBe(1);
      const error = await new Response(child.stderr).text();
      expect(error).toContain("SERVICE_PORT_IN_USE");
      expect(error).not.toContain(identity.mcpToken);
      expect(error).not.toContain(paths.endpoint);
      expect(JSON.parse(await readFile(paths.identity, "utf8")).port).toBe(identity.port);
    } finally { await occupied.stop(true); }
  });

  test("an occupied unauthenticated singleton endpoint cannot start a second server", async () => {
    let captured: unknown;
    const owner = WindowsControlPipe.acquire(paths.endpoint, paths.userSid, message => { captured = message; return { unexpected: true }; })!;
    try {
      const child = launch();
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("SERVICE_IDENTITY_UNVERIFIED");
      expect(JSON.stringify(captured)).not.toContain(identity.managementToken);
      expect(JSON.stringify(captured)).not.toContain(identity.mcpToken);
      expect(captured).toHaveProperty("proof");
      const check = Bun.serve({ hostname: "127.0.0.1", port: identity.port, fetch: () => new Response(null) });
      await check.stop(true);
    } finally { owner.close(); }
  }, 20_000);

  test("private ACL establishment fails closed for an invalid target", () => {
    expect(() => hardenPrivatePath(path.join(root, "missing", "identity.json"), paths.userSid, false)).toThrow("Private Windows permissions");
    expect(() => hardenPrivatePath(paths.identity, "not-a-sid", false)).toThrow("Private Windows permissions");
  });
});
