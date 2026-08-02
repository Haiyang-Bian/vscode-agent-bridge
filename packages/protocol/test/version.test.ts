import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("starts at version one", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
  });
});
