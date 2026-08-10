import { describe, expect, test } from "bun:test";

import {
  BridgeExecutionModeSchema,
  ControlDebugSessionInputSchema,
  GetDebugStateInputSchema,
  PrepareResourceChangesInputSchema,
  RunTaskInputSchema,
  UpdateWorkspaceConfigurationInputSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);

describe("protocol v6 workflow schemas", () => {
  test("defines explicit and aggressive execution modes", () => {
    expect(BridgeExecutionModeSchema.options).toEqual(["explicit", "aggressive"]);
  });

  test("guards structured configuration updates with existence and hash preconditions", () => {
    const valid = {
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      rootUri: "file:///workspace",
      target: "tasks",
      expectedExists: true,
      expectedSha256: HASH,
      operations: [{ operation: "replace", path: "/tasks/0/label", value: "test" }],
      reason: "Keep the test task aligned with the project.",
    };
    expect(UpdateWorkspaceConfigurationInputSchema.parse(valid)).toMatchObject(valid);
    expect(() => UpdateWorkspaceConfigurationInputSchema.parse({ ...valid, expectedSha256: null })).toThrow();
  });

  test("bounds text resource changes and requires explicit routing", () => {
    expect(
      PrepareResourceChangesInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        title: "Create test fixture",
        operations: [
          { operation: "create", kind: "file", uri: "file:///workspace/test.ts", content: "export {};\n" },
        ],
      }),
    ).toMatchObject({ instanceId: INSTANCE_ID, sessionId: SESSION_ID });
  });

  test("binds task execution to a fingerprinted task and experiment", () => {
    expect(
      RunTaskInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        taskId: HASH,
        expectedFingerprint: HASH,
        reason: "Run the configured test task.",
      }),
    ).toMatchObject({ taskId: HASH, expectedFingerprint: HASH });
  });

  test("exposes only typed debug state and control requests", () => {
    expect(
      GetDebugStateInputSchema.parse({
        instanceId: INSTANCE_ID,
        debugSessionId: "debug-1",
        query: "stackTrace",
        threadId: 1,
      }),
    ).toMatchObject({ query: "stackTrace", threadId: 1 });
    expect(
      ControlDebugSessionInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        debugSessionId: "debug-1",
        action: "continue",
        threadId: 1,
        reason: "Continue after inspecting the stopped frame.",
      }),
    ).toMatchObject({ action: "continue" });
    expect(() =>
      ControlDebugSessionInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        debugSessionId: "debug-1",
        action: "customRequest",
        reason: "No generic DAP requests.",
      }),
    ).toThrow();
  });
});
