import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";

import * as vscode from "vscode";

import {
  BRIDGE_CAPABILITIES,
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  BridgeInitializeParamsSchema,
  JsonRpcRequestSchema,
  NdjsonDecoder,
  encodeRpcMessage,
  resolveInstanceDescriptorPath,
  resolveRegistryDirectories,
  resolveTransportDescriptor,
  type InstanceDescriptor,
  type JsonRpcId,
} from "@vscode-agent-bridge/protocol";

import { getEditorContext, getWorkspaceFolders } from "./editor-context.js";

interface ConnectionState {
  authenticated: boolean;
  readonly decoder: NdjsonDecoder;
}

export class BridgeHost {
  readonly instanceId = randomUUID();

  readonly #authToken = randomBytes(32).toString("base64url");
  readonly #createdAt = new Date().toISOString();
  readonly #directories = resolveRegistryDirectories();
  readonly #transport = resolveTransportDescriptor(this.instanceId, this.#directories);
  readonly #descriptorPath = resolveInstanceDescriptorPath(this.instanceId, this.#directories);
  readonly #output: vscode.LogOutputChannel;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #refreshQueue = Promise.resolve();
  #started = false;
  #stopped = false;

  constructor(output: vscode.LogOutputChannel) {
    this.#output = output;
    this.#server = net.createServer((socket) => this.#acceptConnection(socket));
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    await mkdir(this.#directories.instances, { recursive: true, mode: 0o700 });
    await mkdir(this.#directories.sockets, { recursive: true, mode: 0o700 });

    if (this.#transport.kind === "unix-socket") {
      await rm(this.#transport.endpoint, { force: true });
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error): void => {
        this.#server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = (): void => {
        this.#server.off("error", handleError);
        resolve();
      };

      this.#server.once("error", handleError);
      this.#server.once("listening", handleListening);
      this.#server.listen(this.#transport.endpoint);
    });

    this.#started = true;
    await this.#writeDescriptor();
    this.#output.info(`Bridge instance ${this.instanceId} is listening.`);
  }

  refreshDescriptor(): Promise<void> {
    const nextRefresh = this.#refreshQueue
      .catch(() => undefined)
      .then(() => this.#writeDescriptor())
      .catch((error: unknown) => {
        this.#output.error("Failed to refresh bridge instance descriptor.", error);
      });
    this.#refreshQueue = nextRefresh;
    return nextRefresh;
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;

    for (const socket of this.#sockets) {
      socket.destroy();
    }

    if (this.#started) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    await rm(this.#descriptorPath, { force: true });
    if (this.#transport.kind === "unix-socket") {
      await rm(this.#transport.endpoint, { force: true });
    }
  }

  #acceptConnection(socket: Socket): void {
    const state: ConnectionState = {
      authenticated: false,
      decoder: new NdjsonDecoder(),
    };
    this.#sockets.add(socket);
    socket.setTimeout(10_000);

    socket.on("data", (chunk) => {
      try {
        for (const message of state.decoder.push(chunk)) {
          void this.#handleMessage(socket, state, message);
        }
      } catch (error) {
        this.#sendError(socket, null, toBridgeError(error));
        socket.end();
      }
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", (error) => {
      this.#output.debug(`Bridge socket error: ${error.message}`);
    });
    socket.on("close", () => {
      this.#sockets.delete(socket);
    });
  }

  async #handleMessage(
    socket: Socket,
    state: ConnectionState,
    rawMessage: unknown,
  ): Promise<void> {
    const parsedRequest = JsonRpcRequestSchema.safeParse(rawMessage);
    if (!parsedRequest.success) {
      this.#sendError(
        socket,
        null,
        new BridgeError("INVALID_REQUEST", "Message is not a valid JSON-RPC request."),
      );
      socket.end();
      return;
    }

    const request = parsedRequest.data;

    if (request.method === BRIDGE_METHODS.initialize) {
      const parsedParams = BridgeInitializeParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.#sendError(
          socket,
          request.id,
          new BridgeError("PROTOCOL_MISMATCH", "Bridge initialization parameters are invalid."),
        );
        socket.end();
        return;
      }

      if (!tokensMatch(parsedParams.data.authToken, this.#authToken)) {
        this.#sendError(
          socket,
          request.id,
          new BridgeError("AUTHENTICATION_FAILED", "Bridge authentication failed."),
        );
        socket.end();
        return;
      }

      state.authenticated = true;
      this.#sendResult(socket, request.id, {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        instanceId: this.instanceId,
        capabilities: [...BRIDGE_CAPABILITIES],
      });
      return;
    }

    if (!state.authenticated) {
      this.#sendError(
        socket,
        request.id,
        new BridgeError("AUTHENTICATION_FAILED", "Initialize the bridge connection first."),
      );
      socket.end();
      return;
    }

    if (request.method === BRIDGE_METHODS.getEditorContext) {
      this.#sendResult(socket, request.id, getEditorContext(this.instanceId));
      return;
    }

    this.#sendError(
      socket,
      request.id,
      new BridgeError("INVALID_REQUEST", `Unknown bridge method: ${request.method}`),
      -32601,
    );
  }

  #sendResult(socket: Socket, id: JsonRpcId, result: unknown): void {
    socket.write(
      encodeRpcMessage({
        jsonrpc: "2.0",
        id,
        result,
      }),
    );
  }

  #sendError(
    socket: Socket,
    id: JsonRpcId | null,
    error: BridgeError,
    rpcCode = -32000,
  ): void {
    socket.write(
      encodeRpcMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: rpcCode,
          message: error.message,
          data: {
            bridgeCode: error.code,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
      }),
    );
  }

  async #writeDescriptor(): Promise<void> {
    if (this.#stopped) {
      return;
    }

    const descriptor: InstanceDescriptor = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      instanceId: this.instanceId,
      pid: process.pid,
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      remoteName: vscode.env.remoteName ?? null,
      workspaceTrusted: vscode.workspace.isTrusted,
      workspaceFolders: getWorkspaceFolders(),
      transport: this.#transport,
      authToken: this.#authToken,
    };

    await writeFile(this.#descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }

  return new BridgeError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unexpected bridge host error.",
  );
}
