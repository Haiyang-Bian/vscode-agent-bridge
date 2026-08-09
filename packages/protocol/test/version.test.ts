import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version two for the read-only language-service contracts", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(2);
  });
});
