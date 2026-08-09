import { describe, expect, test } from "bun:test";

import {
  ApplyCodeActionInputSchema,
  BRIDGE_ERROR_CODES,
  BRIDGE_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  CODE_ACTION_TTL_MS,
  ListCodeActionsInputSchema,
  ListTerminalExecutionsInputSchema,
  MCP_TOOL_NAMES,
  ReadTerminalOutputInputSchema,
  SaveDocumentInputSchema,
  TerminalReadPolicySchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "a".repeat(64);

describe("protocol v4 IDE autonomy contracts", () => {
  test("registers exactly 21 bounded MCP tools", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(4);
    expect(MCP_TOOL_NAMES).toHaveLength(21);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(21);
    expect(MCP_TOOL_NAMES).toContain("vscode_save_document");
    expect(MCP_TOOL_NAMES).toContain("vscode_read_terminal_output");
    expect(Object.values(BRIDGE_METHODS)).not.toContain("terminals/sendInput");
  });

  test("requires explicit experiment and document preconditions for writes", () => {
    const valid = {
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      uri: "file:///workspace/main.ts",
      expectedVersion: 3,
      expectedSha256: HASH,
      reason: "Persist the verified formatter result.",
    };
    expect(SaveDocumentInputSchema.parse(valid)).toMatchObject(valid);
    expect(() => SaveDocumentInputSchema.parse({ ...valid, instanceId: undefined })).toThrow();
    expect(() => SaveDocumentInputSchema.parse({ ...valid, expectedSha256: undefined })).toThrow();
  });

  test("binds code action handles to explicit experiments", () => {
    expect(
      ListCodeActionsInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        uri: "file:///workspace/main.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
        expectedVersion: 3,
        expectedSha256: HASH,
      }),
    ).toMatchObject({ instanceId: INSTANCE_ID, sessionId: SESSION_ID });
    expect(
      ApplyCodeActionInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        actionId: ACTION_ID,
        reason: "Apply a pure text quick fix.",
      }),
    ).toMatchObject({ actionId: ACTION_ID });
    expect(CODE_ACTION_TTL_MS).toBe(600_000);
  });

  test("bounds terminal pagination and output", () => {
    expect(ListTerminalExecutionsInputSchema.parse({})).toMatchObject({ limit: 50 });
    expect(ReadTerminalOutputInputSchema.parse({ executionId: ACTION_ID })).toMatchObject({
      cursor: 0,
      maxChars: 65_536,
    });
    expect(() =>
      ReadTerminalOutputInputSchema.parse({ executionId: ACTION_ID, maxChars: 200_001 }),
    ).toThrow();
  });

  test("defines policy and stable v4 error codes", () => {
    expect(TerminalReadPolicySchema.options).toEqual(["allow", "metadataOnly", "deny"]);
    for (const code of [
      "POLICY_DENIED",
      "SAVE_FAILED",
      "CODE_ACTION_UNSUPPORTED",
      "TERMINAL_OUTPUT_UNAVAILABLE",
    ] as const) {
      expect(BRIDGE_ERROR_CODES).toContain(code);
    }
  });
});
