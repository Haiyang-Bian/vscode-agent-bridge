import { describe, expect, test } from "bun:test";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { TerminalCaptureStore, TerminalOutputSanitizer } from "../src/terminal-capture.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TERMINAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_TERMINAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXECUTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_EXECUTION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("terminal output sanitizer", () => {
  test("strips split ANSI and OSC control sequences without logging raw controls", () => {
    const sanitizer = new TerminalOutputSanitizer();
    const first = sanitizer.push("before\u001b[31");
    const second = sanitizer.push("mred\u001b[0m\r\n\u001b]0;secret");
    const third = sanitizer.push(" title\u0007after\u0000");
    expect(first + second + third + sanitizer.finish()).toBe("beforered\nafter");
  });

  test("normalizes carriage-return progress into readable lines", () => {
    const sanitizer = new TerminalOutputSanitizer();
    expect(sanitizer.push("one\rtwo\r") + sanitizer.finish()).toBe("one\ntwo\n");
  });
});

describe("terminal capture store", () => {
  test("captures live output, exit status and cursor pages", () => {
    let now = Date.parse("2026-08-09T00:00:00.000Z");
    const store = new TerminalCaptureStore(INSTANCE_ID, {}, () => now);
    registerTerminal(store, TERMINAL_ID);
    store.startExecution({
      executionId: EXECUTION_ID,
      terminalId: TERMINAL_ID,
      commandLine: "bun test",
      commandConfidence: "high",
      commandLineTrusted: true,
      cwd: "file:///workspace",
    });
    store.appendOutput(EXECUTION_ID, "first\nsecond\n");

    const running = store.listExecutions({ limit: 50 });
    expect(running.executions[0]).toMatchObject({
      status: "running",
      commandLine: "bun test",
      capturedCharacters: 13,
    });
    expect(store.listTerminals("full").terminals[0]?.status).toBe("running");

    const firstPage = store.readOutput({ executionId: EXECUTION_ID, cursor: 0, maxChars: 6 });
    expect(firstPage).toMatchObject({ text: "first\n", nextCursor: 6, truncated: true });
    expect(
      store.readOutput({ executionId: EXECUTION_ID, cursor: firstPage.nextCursor!, maxChars: 100 })
        .text,
    ).toBe("second\n");

    now += 1000;
    store.finishOutput(EXECUTION_ID);
    store.finishExecution(EXECUTION_ID, 0);
    expect(store.listExecutions({ limit: 50 }).executions[0]).toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    expect(store.listTerminals("full").terminals[0]?.status).toBe("idle");
    expect(store.getStats()).toMatchObject({ executionsWithCompleteCoverage: 1 });
  });

  test("redacts sensitive fields for metadata-only access and reports activation gaps", () => {
    const store = new TerminalCaptureStore(INSTANCE_ID);
    store.registerTerminal({
      terminalId: TERMINAL_ID,
      name: "PowerShell",
      processId: 42,
      isActive: true,
      shellIntegration: false,
      cwd: "file:///private/path",
      existedAtActivation: true,
    });
    expect(store.listTerminals("metadata").terminals[0]).toMatchObject({
      cwd: null,
      coverage: { commandLine: "redacted", cwd: "redacted", output: "redacted" },
    });
    expect(store.listTerminals("full").terminals[0]).toMatchObject({
      status: "unknown",
      coverage: { output: "started-before-activation" },
    });
  });

  test("drops old prefixes at per-execution limits and reports the actual cursor", () => {
    const store = new TerminalCaptureStore(INSTANCE_ID, {
      executionBytes: 8,
      windowBytes: 64,
    });
    registerTerminal(store, TERMINAL_ID);
    startExecution(store, EXECUTION_ID, TERMINAL_ID);
    store.appendOutput(EXECUTION_ID, "0123456789");
    store.finishOutput(EXECUTION_ID);
    store.finishExecution(EXECUTION_ID, 0);
    const result = store.readOutput({ executionId: EXECUTION_ID, cursor: 0, maxChars: 20 });
    expect(result).toMatchObject({
      cursor: 2,
      text: "23456789",
      droppedCharacters: 2,
      coverage: "partial-dropped",
    });
  });

  test("evicts the oldest completed output before active output at the window limit", () => {
    let now = Date.parse("2026-08-09T00:00:00.000Z");
    const store = new TerminalCaptureStore(
      INSTANCE_ID,
      { executionBytes: 16, windowBytes: 10 },
      () => now,
    );
    registerTerminal(store, TERMINAL_ID);
    registerTerminal(store, SECOND_TERMINAL_ID);
    startExecution(store, EXECUTION_ID, TERMINAL_ID);
    store.appendOutput(EXECUTION_ID, "123456");
    store.finishOutput(EXECUTION_ID);
    store.finishExecution(EXECUTION_ID, 0);
    now += 1000;
    startExecution(store, SECOND_EXECUTION_ID, SECOND_TERMINAL_ID);
    store.appendOutput(SECOND_EXECUTION_ID, "abcdef");

    expect(() =>
      store.readOutput({ executionId: EXECUTION_ID, cursor: 0, maxChars: 20 }),
    ).toThrow(BridgeError);
    expect(
      store.readOutput({ executionId: SECOND_EXECUTION_ID, cursor: 0, maxChars: 20 }).text,
    ).toBe("abcdef");
    expect(store.getStats().memoryBytes).toBeLessThanOrEqual(10);
  });

  test("paginates executions and expires closed terminal records", () => {
    let now = Date.parse("2026-08-09T00:00:00.000Z");
    const store = new TerminalCaptureStore(
      INSTANCE_ID,
      { closedRetentionMs: 1000 },
      () => now,
    );
    registerTerminal(store, TERMINAL_ID);
    startExecution(store, EXECUTION_ID, TERMINAL_ID);
    store.finishOutput(EXECUTION_ID);
    store.finishExecution(EXECUTION_ID, 0);
    now += 100;
    startExecution(store, SECOND_EXECUTION_ID, TERMINAL_ID);
    const firstPage = store.listExecutions({ limit: 1 });
    expect(firstPage.returnedCount).toBe(1);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(store.listExecutions({ limit: 1, cursor: firstPage.nextCursor! }).returnedCount).toBe(1);

    store.closeTerminal(TERMINAL_ID, 0);
    now += 1001;
    expect(store.listTerminals("full").terminals).toEqual([]);
    expect(store.listExecutions({ limit: 50 }).executions).toEqual([]);
  });
});

function registerTerminal(
  store: TerminalCaptureStore,
  terminalId: string,
): void {
  store.registerTerminal({
    terminalId,
    name: "PowerShell",
    processId: 42,
    isActive: true,
    shellIntegration: true,
    cwd: "file:///workspace",
    existedAtActivation: false,
  });
}

function startExecution(
  store: TerminalCaptureStore,
  executionId: string,
  terminalId: string,
): void {
  store.startExecution({
    executionId,
    terminalId,
    commandLine: "test",
    commandConfidence: "high",
    commandLineTrusted: true,
    cwd: "file:///workspace",
  });
}
