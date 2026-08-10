import { describe, expect, test } from "bun:test";

import { BRIDGE_PROTOCOL_VERSION } from "../src/index.js";

describe("bridge protocol version", () => {
  test("uses version eight for extension awareness and IDE signals", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(8);
  });
});
