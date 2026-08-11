import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version eleven for IDE-mediated autonomous execution", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(11);
  });
});
