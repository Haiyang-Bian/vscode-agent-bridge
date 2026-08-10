import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version nine for extension marketplace and Profile orchestration", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(9);
  });
});
