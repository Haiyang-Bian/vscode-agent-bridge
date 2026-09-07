import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BRIDGE_PROTOCOL_VERSION, NdjsonDecoder, REGISTRY_DIRECTORY_ENV, encodeRpcMessage, resolveRegistryDirectories, resolveTransportDescriptor, type InstanceDescriptor } from "@vscode-agent-bridge/protocol";
import { HttpMcpRuntime } from "../src/http-runtime.js";
import { UsageInsightStore } from "../src/usage-insights.js";

let root: string, previous: string | undefined, runtime: HttpMcpRuntime, client: Client;
const servers: net.Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-http-discovery-"));
  previous = process.env[REGISTRY_DIRECTORY_ENV]; process.env[REGISTRY_DIRECTORY_ENV] = root;
  await mkdir(path.join(root, "instances"));
  runtime = new HttpMcpRuntime({ identity: { serviceId: "a".repeat(32), mcpToken: "b".repeat(64), port: 0 }, usageInsights: new UsageInsightStore(root) });
  runtime.start();
  client = new Client({ name: "discovery-contract-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(runtime.url), { requestInit: { headers: { Authorization: `Bearer ${"b".repeat(64)}` } } }) as Transport);
});
afterEach(async () => {
  await client.close(); await runtime.stop();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (previous === undefined) delete process.env[REGISTRY_DIRECTORY_ENV]; else process.env[REGISTRY_DIRECTORY_ENV] = previous;
  await rm(root, { recursive: true, force: true });
});

test("one HTTP session observes later IDE publication, degradation, incompatibility, replacement and exit", async () => {
  const pid = runtime.status.pid;
  expect((await client.callTool({ name: "vscode_list_instances", arguments: {} })).structuredContent).toEqual({ instances: [] });
  const first = await bridgeFixture("initializing");
  async function list() { return (await client.callTool({ name: "vscode_list_instances", arguments: {} })).structuredContent as { instances: Array<{ instanceId: string; lifecycle: string; compatibility: string }> }; }
  async function context(instanceId?: string) { return await client.callTool({ name: "vscode_get_editor_context", arguments: instanceId ? { instanceId } : {} }); }
  expect((await list()).instances[0]?.lifecycle).toBe("initializing");
  expect(JSON.stringify((await context()).content)).toContain("BRIDGE_INITIALIZING");
  await first.publish("degraded");
  expect((await list()).instances[0]?.lifecycle).toBe("degraded");
  expect(JSON.stringify((await context()).content)).toContain("BRIDGE_DEGRADED");
  await first.publish("ready");
  const second = await bridgeFixture("ready");
  expect(JSON.stringify((await context()).content)).toContain("AMBIGUOUS_INSTANCE");
  expect(JSON.stringify((await context(second.descriptor.instanceId)).content)).toContain("NO_ACTIVE_EDITOR");
  const old = { ...second.descriptor, instanceId: randomUUID(), protocolVersion: BRIDGE_PROTOCOL_VERSION - 1 };
  await writeFile(path.join(root, "instances", `${old.instanceId}.json`), JSON.stringify(old));
  expect((await list()).instances.find(instance => instance.instanceId === old.instanceId)?.compatibility).toBe("incompatible");
  expect(JSON.stringify((await context(old.instanceId)).content)).toContain("PROTOCOL_MISMATCH");
  await first.close();
  expect((await list()).instances.some(instance => instance.instanceId === first.descriptor.instanceId)).toBe(false);
  const replacement = await bridgeFixture("ready");
  expect((await list()).instances.some(instance => instance.instanceId === replacement.descriptor.instanceId)).toBe(true);
  await replacement.close(); await second.close(); await rm(path.join(root, "instances", `${old.instanceId}.json`));
  expect((await list()).instances).toEqual([]);
  expect(runtime.status.pid).toBe(pid); expect(runtime.status.state).toBe("ready");
});

async function bridgeFixture(initial: InstanceDescriptor["lifecycle"]) {
  const instanceId = randomUUID(); let lifecycle = initial;
  const descriptor: InstanceDescriptor = { instanceId, lifecycle, protocolVersion: BRIDGE_PROTOCOL_VERSION, extensionVersion: "0.12.0",
    pid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appName: "Contract fixture", appHost: "desktop",
    remoteName: null, workspaceTrusted: true, workspaceFolders: [], authToken: "c".repeat(43), transport: resolveTransportDescriptor(instanceId, resolveRegistryDirectories()) };
  const server = net.createServer(socket => {
    const decoder = new NdjsonDecoder();
    socket.on("data", chunk => {
      for (const raw of decoder.push(chunk)) {
        const request = raw as { id: number; method: string; params: { authToken?: string } };
        if (request.method === "bridge/initialize" && request.params.authToken === descriptor.authToken) {
          socket.write(encodeRpcMessage({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: BRIDGE_PROTOCOL_VERSION, instanceId, lifecycle, capabilities: [] } }));
        } else {
          const code = lifecycle === "initializing" ? "BRIDGE_INITIALIZING" : lifecycle === "degraded" ? "BRIDGE_DEGRADED" : "NO_ACTIVE_EDITOR";
          socket.write(encodeRpcMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Fixture lifecycle", data: { bridgeCode: code } } }));
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(descriptor.transport.endpoint, resolve); });
  const publish = async (next: InstanceDescriptor["lifecycle"]) => {
    lifecycle = next;
    await writeFile(path.join(root, "instances", `${instanceId}.json`), JSON.stringify({ ...descriptor, lifecycle }));
  };
  await publish(initial);
  return { descriptor, publish, async close() { await new Promise<void>(resolve => server.close(() => resolve())); } };
}
