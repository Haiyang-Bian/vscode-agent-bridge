import { describe, expect, test } from "bun:test";

import {
  BridgeExecutionModeSchema,
  ControlDebugSessionInputSchema,
  GetDebugStateInputSchema,
  PersistDebugConfigurationInputSchema,
  PersistTaskInputSchema,
  PrepareDebugConfigurationInputSchema,
  PrepareResourceChangesInputSchema,
  PrepareTaskInputSchema,
  RunTaskInputSchema,
  StartDebugSessionInputSchema,
  UpdateWorkspaceConfigurationInputSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);

describe("protocol v11 workflow schemas", () => {
  test("keeps only explicit Agent-initiated execution", () => {
    expect(BridgeExecutionModeSchema.parse("explicit")).toBe("explicit");
    expect(() => BridgeExecutionModeSchema.parse("aggressive")).toThrow();
  });

  test("guards structured configuration updates with existence and hash preconditions", () => {
    const valid = {
      instanceId: INSTANCE_ID,
      sessionId: SESSION_ID,
      rootUri: "file:///workspace",
      target: "settings",
      expectedExists: true,
      expectedSha256: HASH,
      operations: [{ operation: "replace", path: "/editor.formatOnSave", value: true }],
      reason: "Keep the editor setting aligned with the project.",
    };
    expect(UpdateWorkspaceConfigurationInputSchema.parse(valid)).toMatchObject(valid);
    expect(() => UpdateWorkspaceConfigurationInputSchema.parse({ ...valid, expectedSha256: null })).toThrow();
    expect(() => UpdateWorkspaceConfigurationInputSchema.parse({ ...valid, target: "tasks" })).toThrow();
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
      PrepareTaskInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        label: "Agent tests",
        execution: {
          kind: "shell",
          command: "bun",
          args: ["test"],
          options: { cwd: ".", env: { CI: "1" } },
        },
        group: "test",
        reason: "Run tests through a visible VS Code Task.",
      }),
    ).toMatchObject({ label: "Agent tests", execution: { kind: "shell", command: "bun" } });
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
    expect(
      PersistTaskInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        preparedTaskId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        expectedExists: false,
        expectedSha256: null,
        reason: "Persist the reusable test Task.",
      }),
    ).toMatchObject({ expectedExists: false, expectedSha256: null });
  });

  test("prepares bounded Debug configurations with explicit Task bindings", () => {
    expect(
      PrepareDebugConfigurationInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        configuration: { name: "Agent debug", type: "node", request: "launch", program: "src/index.ts" },
        preLaunchTask: { taskId: HASH, expectedFingerprint: HASH },
        reason: "Debug the generated program through VS Code.",
      }),
    ).toMatchObject({ configuration: { name: "Agent debug", request: "launch" } });
    expect(() =>
      PrepareDebugConfigurationInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        configuration: { name: "Hidden task", type: "node", request: "launch", preLaunchTask: "build" },
        reason: "Do not hide Task execution inside raw Debug configuration.",
      }),
    ).toThrow();
    expect(
      PersistDebugConfigurationInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        preparedConfigurationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        expectedExists: true,
        expectedSha256: HASH,
        reason: "Persist the reviewed Debug configuration.",
      }),
    ).toMatchObject({ expectedSha256: HASH });
    expect(
      StartDebugSessionInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        rootUri: "file:///workspace",
        configurationId: HASH,
        expectedFingerprint: HASH,
        reason: "Start the exact prepared Debug configuration.",
      }),
    ).toMatchObject({ configurationId: HASH });
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
