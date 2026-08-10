import { randomUUID } from "node:crypto";
import net, { type Server, type Socket } from "node:net";

import { afterEach, describe, expect, test } from "bun:test";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  BridgeError,
  NdjsonDecoder,
  encodeRpcMessage,
  resolveRegistryDirectories,
  resolveTransportDescriptor,
  type InstanceDescriptor,
} from "@vscode-agent-bridge/protocol";

import { requestBridgeResult } from "../src/rpc-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Bridge RPC cancellation", () => {
  test("destroys the bridge socket when an inner request times out", async () => {
    const fixture = await createSlowBridge();
    await expect(
      requestBridgeResult(fixture.descriptor, "test/slow", {}, (value) => value, {
        timeoutMilliseconds: 50,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await fixture.closed;
  });

  test("propagates caller cancellation by closing the bridge socket", async () => {
    const fixture = await createSlowBridge();
    const controller = new AbortController();
    const request = requestBridgeResult(fixture.descriptor, "test/slow", {}, (value) => value, {
      signal: controller.signal,
      timeoutMilliseconds: 5_000,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await fixture.closed;
  });
});

async function createSlowBridge(): Promise<{
  descriptor: InstanceDescriptor;
  closed: Promise<void>;
}> {
  const instanceId = randomUUID();
  const transport = resolveTransportDescriptor(
    instanceId,
    resolveRegistryDirectories({ homeDirectory: process.cwd() }),
  );
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = net.createServer((socket) =>
    handleConnection(socket, resolveClosed, instanceId),
  );
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(transport.endpoint, resolve);
  });
  return {
    descriptor: {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      extensionVersion: BRIDGE_RELEASE_VERSION,
      instanceId,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appName: "VS Code Agent Bridge test",
      appHost: "desktop",
      remoteName: null,
      workspaceTrusted: true,
      lifecycle: "ready",
      workspaceFolders: [],
      transport,
      authToken: "a".repeat(43),
    },
    closed,
  };
}

function handleConnection(
  socket: Socket,
  resolveClosed: () => void,
  instanceId: string,
): void {
  const decoder = new NdjsonDecoder();
  socket.on("data", (chunk) => {
    for (const raw of decoder.push(chunk)) {
      const request = raw as { id: number; method: string };
      if (request.method === "bridge/initialize") {
        socket.write(
          encodeRpcMessage({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
              instanceId,
              lifecycle: "ready",
              capabilities: [],
            },
          }),
        );
      }
    }
  });
  socket.once("close", resolveClosed);
}
