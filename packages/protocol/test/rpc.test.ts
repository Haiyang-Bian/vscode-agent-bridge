import { describe, expect, test } from "bun:test";

import { BridgeError, NdjsonDecoder, encodeRpcMessage } from "../src/index.js";

describe("NDJSON RPC framing", () => {
  test("decodes fragmented and batched messages", () => {
    const decoder = new NdjsonDecoder();

    expect(decoder.push('{"id":1')).toEqual([]);
    expect(decoder.push('}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("encodes exactly one newline-delimited message", () => {
    expect(encodeRpcMessage({ ok: true }).toString("utf8")).toBe('{"ok":true}\n');
  });

  test("rejects oversized incomplete messages", () => {
    const decoder = new NdjsonDecoder(4);

    expect(() => decoder.push("12345")).toThrow(BridgeError);
  });

  test("rejects malformed JSON", () => {
    const decoder = new NdjsonDecoder();

    expect(() => decoder.push("not-json\n")).toThrow("RPC message is not valid JSON.");
  });
});
