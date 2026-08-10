import { describe, expect, test } from "bun:test";

import {
  GetExtensionConfigurationSchemaInputSchema,
  ListDebugOutputInputSchema,
  ListDiagnosticEventsInputSchema,
  ListExtensionsInputSchema,
  ReadDebugOutputInputSchema,
  ReadVisibleOutputInputSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("protocol v8 extension and IDE signal schemas", () => {
  test("bounds extension and configuration pagination", () => {
    expect(ListExtensionsInputSchema.parse({ instanceId: INSTANCE_ID })).toMatchObject({
      offset: 0,
      limit: 200,
      activeOnly: false,
      includeBuiltIn: true,
    });
    expect(() =>
      GetExtensionConfigurationSchemaInputSchema.parse({
        instanceId: INSTANCE_ID,
        extensionId: "ms-python.python",
        limit: 1001,
      }),
    ).toThrow();
  });

  test("uses explicit bounded cursors for output, diagnostics and debug console", () => {
    expect(ReadVisibleOutputInputSchema.parse({ instanceId: INSTANCE_ID, sourceId: "visible:one" })).toMatchObject({
      cursor: 0,
      maxChars: 65_536,
    });
    expect(ListDiagnosticEventsInputSchema.parse({ instanceId: INSTANCE_ID })).toMatchObject({
      afterCursor: 0,
      limit: 200,
    });
    expect(ListDebugOutputInputSchema.parse({ instanceId: INSTANCE_ID })).toMatchObject({
      includeTerminated: true,
      offset: 0,
    });
    expect(ReadDebugOutputInputSchema.parse({ instanceId: INSTANCE_ID, debugSessionId: "debug-1" })).toMatchObject({
      cursor: 0,
      maxChars: 65_536,
    });
  });
});
