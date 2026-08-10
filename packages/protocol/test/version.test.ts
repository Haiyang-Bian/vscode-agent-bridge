import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version seven for the Bridge Hub and insights", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(7);
  });
});
