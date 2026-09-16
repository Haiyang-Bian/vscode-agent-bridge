import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { MCP_TOOL_CATALOG, MCP_TOOL_NAMES, REGISTRY_DIRECTORY_ENV, SERVICE_LIMITS } from "@vscode-agent-bridge/protocol";
import { HttpMcpRuntime, type HttpRuntimeOptions } from "../src/http-runtime.js";
import { UsageInsightStore } from "../src/usage-insights.js";

let root: string;
let previousRegistry: string | undefined;
let runtime: HttpMcpRuntime;
const clients: Client[] = [];
const token = "a".repeat(64);
const headers = { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bridge-http-test-"));
  previousRegistry = process.env[REGISTRY_DIRECTORY_ENV];
  process.env[REGISTRY_DIRECTORY_ENV] = root;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await runtime?.stop();
  if (previousRegistry === undefined) delete process.env[REGISTRY_DIRECTORY_ENV];
  else process.env[REGISTRY_DIRECTORY_ENV] = previousRegistry;
  await rm(root, { recursive: true, force: true });
});

function start(options: Partial<HttpRuntimeOptions> = {}): void {
  runtime = new HttpMcpRuntime({
    identity: { serviceId: "b".repeat(32), mcpToken: token, port: 0 },
    usageInsights: new UsageInsightStore(root), ...options,
    limits: { shutdownGraceMs: 0, ...options.limits },
  });
  runtime.start();
}
async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "http-runtime-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.url), { requestInit: { headers: { Authorization: headers.Authorization } } });
  clients.push(client);
  // SDK 1.30 declares sessionId as string | undefined, while Transport uses an
  // exact optional property. Its runtime implementation satisfies Transport.
  await client.connect(transport as Transport);
  return { client, transport };
}
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for request state.");
    await Bun.sleep(10);
  }
}
function slowFactory(pending: Array<{ signal: AbortSignal; finish: () => void }>): NonNullable<HttpRuntimeOptions["createSession"]> {
  return (_usage, hooks) => {
    const server = new McpServer({ name: "slow-test", version: "1" });
    server.registerTool("slow", { inputSchema: z.object({}) }, async (_input, extra) =>
      hooks.runTool(extra.requestId, extra.signal, async signal => {
        await new Promise<void>(resolve => pending.push({ signal, finish: resolve }));
        return { content: [{ type: "text", text: signal.aborted ? "cancelled" : "done" }] };
      }));
    return server;
  };
}

describe("HTTP MCP runtime", () => {
  test("shares one process across clients while preserving all 64 tool contracts without VS Code", async () => {
    start();
    const first = await connect(), second = await connect();
    const tools = await first.client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const entry of MCP_TOOL_CATALOG) expect(tools.tools.find(tool => tool.name === entry.name)?.annotations).toEqual(entry.annotations);
    expect((await first.client.callTool({ name: "vscode_list_instances", arguments: {} })).structuredContent).toEqual({ instances: [] });
    const missing = await second.client.callTool({ name: "vscode_get_editor_context", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("NO_VSCODE_INSTANCE");
    expect(runtime.status.pid).toBe(process.pid);
    expect(runtime.status.sessions).toBe(2);
    expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
    await first.transport.terminateSession();
    expect(runtime.status.sessions).toBe(1);
    expect((await second.client.listTools()).tools).toHaveLength(64);
    await first.client.close();
  });

  test("authenticates all routes and rejects unsafe Host, Origin and replay", async () => {
    start();
    for (const endpoint of [runtime.url, runtime.url.replace("/mcp", "/health"), runtime.url.replace("/mcp", "/unknown")]) {
      expect((await fetch(endpoint)).status).toBe(401);
    }
    expect((await fetch(runtime.url, { headers: { ...headers, Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(runtime.url, { headers: { ...headers, Host: "evil.example" } })).status).toBe(403);
    expect((await fetch(runtime.url, { headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(runtime.url, { headers: { ...headers, Origin: "null" } })).status).toBe(403);
    expect((await fetch(runtime.url, { headers: { ...headers, "Last-Event-ID": "unavailable" } })).status).toBe(400);
    const health = await fetch(runtime.url.replace("/mcp", "/health"), { headers });
    expect(health.status).toBe(200);
    expect(JSON.stringify(await health.json())).not.toContain(token);
  });

  test("limits session admission and expires idle sessions without evicting active work", async () => {
    let now = Date.now();
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    start({ now: () => now, limits: { sessions: 1, sessionIdleMs: 100 }, createSession: slowFactory(pending) });
    const first = await connect();
    const denied = await fetch(runtime.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "denied", version: "1" } } }) });
    expect(denied.status).toBe(429);
    const call = first.client.callTool({ name: "slow", arguments: {} });
    await eventually(() => pending.length === 1);
    now += 1000;
    await runtime.sweepIdleSessions();
    expect(runtime.status.sessions).toBe(1);
    pending[0]!.finish();
    await call;
    now += 1000;
    await runtime.sweepIdleSessions();
    expect(runtime.status.sessions).toBe(0);
    const expired = await fetch(runtime.url, { headers: { ...headers, "Mcp-Session-Id": first.transport.sessionId! } });
    expect(expired.status).toBe(404);
  });

  test("cancellation stays admissible at saturation and holds capacity until work actually settles", async () => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    start({ limits: { requestsPerSession: 1, requestsGlobal: 2 }, createSession: slowFactory(pending) });
    const first = await connect(), second = await connect();
    const controller = new AbortController();
    const cancelled = first.client.callTool({ name: "slow", arguments: {} }, undefined, { signal: controller.signal }).catch(() => null);
    const surviving = second.client.callTool({ name: "slow", arguments: {} });
    await eventually(() => pending.length === 2);
    const denied = await fetch(runtime.url, { method: "POST", headers: { ...headers, "Mcp-Session-Id": first.transport.sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 900, method: "tools/list" }) });
    expect(denied.status).toBe(429);
    controller.abort();
    await cancelled;
    await eventually(() => pending[0]!.signal.aborted);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(runtime.status.activeRequests).toBe(2);
    pending[0]!.finish();
    await eventually(() => runtime.status.activeRequests === 1);
    pending[1]!.finish();
    expect((await surviving).content).toEqual([{ type: "text", text: "done" }]);
    await eventually(() => runtime.status.activeRequests === 0);
  });

  test("an HTTP disconnect alone does not cancel the operation", async () => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    start({ createSession: slowFactory(pending) });
    const { transport } = await connect();
    const controller = new AbortController();
    const request = fetch(runtime.url, { method: "POST", headers: { ...headers, "Mcp-Session-Id": transport.sessionId! }, signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 501, method: "tools/call", params: { name: "slow", arguments: {} } }) });
    const exchange = request.then(async response => { await response.text(); }).catch(() => undefined);
    await eventually(() => pending.length === 1);
    controller.abort();
    await exchange;
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(runtime.status.activeRequests).toBe(1);
    pending[0]!.finish();
    await eventually(() => runtime.status.activeRequests === 0);
  });

  test("request deadlines and session DELETE cancel only their own work", async () => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    start({ limits: { requestTimeoutMs: 150 }, createSession: slowFactory(pending) });
    const first = await connect();
    const call = first.client.callTool({ name: "slow", arguments: {} }).catch(() => null);
    await eventually(() => pending.length === 1);
    await eventually(() => pending[0]!.signal.aborted);
    pending[0]!.finish();
    await call;
    const next = first.client.callTool({ name: "slow", arguments: {} }).catch(() => null);
    await eventually(() => pending.length === 2);
    await first.transport.terminateSession();
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.finish();
    await next;
    await eventually(() => runtime.status.activeRequests === 0);
    expect(SERVICE_LIMITS).toMatchObject({ sessions: 128, requestsPerSession: 8, requestsGlobal: 64 });
  });

  test("global admission, invalid sessions and shutdown preserve bounded request ownership", async () => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    start({ limits: { requestsGlobal: 1, shutdownGraceMs: 75 }, createSession: slowFactory(pending) });
    const first = await connect(), second = await connect();
    expect((await fetch(runtime.url, { headers: { ...headers, "Mcp-Session-Id": "not-a-session" } })).status).toBe(404);
    const work = first.client.callTool({ name: "slow", arguments: {} }).catch(() => null);
    await eventually(() => pending.length === 1);
    const denied = await fetch(runtime.url, { method: "POST", headers: { ...headers, "Mcp-Session-Id": second.transport.sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 111, method: "tools/list" }) });
    expect(denied.status).toBe(429);
    pending[0]!.signal.addEventListener("abort", pending[0]!.finish, { once: true });
    const stopped = runtime.stop();
    expect(runtime.status.state).toBe("stopping");
    expect(pending[0]!.signal.aborted).toBe(false);
    expect((await fetch(runtime.url, { headers })).status).toBe(503);
    await stopped; await work;
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(runtime.status.sessions).toBe(0);
    expect(runtime.status.activeRequests).toBe(0);
  });
});
