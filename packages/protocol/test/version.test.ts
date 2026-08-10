import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version five for workspace reflexivity and visible agent activity", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(5);
  });
});
