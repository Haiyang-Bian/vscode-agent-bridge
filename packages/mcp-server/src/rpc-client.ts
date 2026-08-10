import net, { type Socket } from "node:net";

import {
  BRIDGE_METHODS,
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RELEASE_VERSION,
  BridgeError,
  BridgeInitializeResultSchema,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  EditorContextSchema,
  JsonRpcResponseSchema,
  NdjsonDecoder,
  encodeRpcMessage,
  type EditorContext,
  type InstanceDescriptor,
  type JsonRpcId,
} from "@vscode-agent-bridge/protocol";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export interface BridgeRequestOptions {
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export class BridgeRpcClient {
  readonly #socket: Socket;
  readonly #timeoutMilliseconds: number;
  readonly #decoder = new NdjsonDecoder();
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextRequestId = 1;

  private constructor(socket: Socket, timeoutMilliseconds: number) {
    this.#socket = socket;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    socket.on("data", (chunk) => this.#handleData(chunk));
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => {
      this.#failAll(new BridgeError("INSTANCE_UNAVAILABLE", "VS Code bridge disconnected."));
    });
  }

  static async connect(
    descriptor: InstanceDescriptor,
    timeoutMilliseconds = DEFAULT_BRIDGE_TIMEOUT_MS,
  ): Promise<BridgeRpcClient> {
    const socket = net.createConnection(descriptor.transport.endpoint);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new BridgeError("TIMEOUT", "Timed out while connecting to VS Code."));
      }, timeoutMilliseconds);
      const handleConnect = (): void => {
        clearTimeout(timeout);
        socket.off("error", handleError);
        resolve();
      };
      const handleError = (error: Error): void => {
        clearTimeout(timeout);
        socket.off("connect", handleConnect);
        reject(
          new BridgeError("INSTANCE_UNAVAILABLE", "Could not connect to the VS Code bridge.", {
            cause: error.message,
          }),
        );
      };

      socket.once("connect", handleConnect);
      socket.once("error", handleError);
    });

    const client = new BridgeRpcClient(socket, timeoutMilliseconds);
    try {
      const initializeResult = BridgeInitializeResultSchema.parse(
        await client.request(BRIDGE_METHODS.initialize, {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          authToken: descriptor.authToken,
          client: {
            name: BRIDGE_NAME,
            version: BRIDGE_RELEASE_VERSION,
          },
        }),
      );

      if (initializeResult.instanceId !== descriptor.instanceId) {
        throw new BridgeError(
          "PROTOCOL_MISMATCH",
          "The connected VS Code instance does not match its registry descriptor.",
        );
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request(method: string, params: unknown, options: BridgeRequestOptions = {}): Promise<unknown> {
    const id = this.#nextRequestId++;
    const timeoutMilliseconds = options.timeoutMilliseconds ?? this.#timeoutMilliseconds;

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new BridgeError("REQUEST_CANCELLED", `Cancelled while calling ${method}.`));
        return;
      }
      const handleAbort = (): void => {
        this.#pending.delete(id);
        cleanup();
        reject(new BridgeError("REQUEST_CANCELLED", `Cancelled while calling ${method}.`));
        this.#socket.destroy();
      };
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        reject(new BridgeError("TIMEOUT", `Timed out while calling ${method}.`));
        this.#socket.destroy();
      }, timeoutMilliseconds);
      const cleanup = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", handleAbort);
      };

      options.signal?.addEventListener("abort", handleAbort, { once: true });
      this.#pending.set(id, { resolve, reject, cleanup });
      this.#socket.write(
        encodeRpcMessage({
          jsonrpc: "2.0",
          id,
          method,
          params,
        }),
      );
    });
  }

  close(): void {
    this.#socket.destroy();
    this.#failAll(new BridgeError("INSTANCE_UNAVAILABLE", "VS Code bridge connection closed."));
  }

  #handleData(chunk: Buffer | string): void {
    try {
      for (const rawMessage of this.#decoder.push(chunk)) {
        const response = JsonRpcResponseSchema.parse(rawMessage);
        if (response.id === null) {
          continue;
        }

        const pending = this.#pending.get(response.id);
        if (!pending) {
          continue;
        }
        this.#pending.delete(response.id);
        pending.cleanup();

        if ("result" in response) {
          pending.resolve(response.result);
        } else {
          pending.reject(
            new BridgeError(
              response.error.data?.bridgeCode ?? "INTERNAL_ERROR",
              response.error.message,
              response.error.data?.details,
            ),
          );
        }
      }
    } catch (error) {
      this.#failAll(
        error instanceof Error
          ? error
          : new BridgeError("INTERNAL_ERROR", "Invalid response from VS Code bridge."),
      );
      this.#socket.destroy();
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export async function requestEditorContext(
  descriptor: InstanceDescriptor,
): Promise<EditorContext> {
  return requestBridgeResult(descriptor, BRIDGE_METHODS.getEditorContext, {}, (value) =>
    EditorContextSchema.parse(value),
  );
}

export async function requestBridgeResult<Result>(
  descriptor: InstanceDescriptor,
  method: string,
  params: unknown,
  parseResult: (value: unknown) => Result,
  options: BridgeRequestOptions = {},
): Promise<Result> {
  if (options.signal?.aborted) {
    throw new BridgeError("REQUEST_CANCELLED", `Cancelled while calling ${method}.`);
  }
  const client = await BridgeRpcClient.connect(descriptor);
  try {
    return parseResult(await client.request(method, params, options));
  } finally {
    client.close();
  }
}

export async function probeBridge(
  descriptor: InstanceDescriptor,
  timeoutMilliseconds = 750,
): Promise<void> {
  const client = await BridgeRpcClient.connect(descriptor, timeoutMilliseconds);
  client.close();
}
