import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version three for experiment sessions and guarded edits", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(3);
  });
});
