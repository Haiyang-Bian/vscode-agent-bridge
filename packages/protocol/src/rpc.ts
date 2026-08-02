import { BridgeError } from "./errors.js";
import { MAX_RPC_MESSAGE_BYTES } from "./constants.js";

export class NdjsonDecoder {
  readonly #maximumMessageBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(maximumMessageBytes = MAX_RPC_MESSAGE_BYTES) {
    this.#maximumMessageBytes = maximumMessageBytes;
  }

  push(chunk: Uint8Array | string): unknown[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    const messages: unknown[] = [];

    for (;;) {
      const newlineIndex = this.#buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        break;
      }

      if (newlineIndex > this.#maximumMessageBytes) {
        throw new BridgeError("INVALID_REQUEST", "RPC message exceeds the size limit.");
      }

      let line = this.#buffer.subarray(0, newlineIndex);
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);

      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }

      try {
        messages.push(JSON.parse(line.toString("utf8")));
      } catch {
        throw new BridgeError("INVALID_REQUEST", "RPC message is not valid JSON.");
      }
    }

    if (this.#buffer.length > this.#maximumMessageBytes) {
      throw new BridgeError("INVALID_REQUEST", "RPC message exceeds the size limit.");
    }

    return messages;
  }
}

export function encodeRpcMessage(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}
