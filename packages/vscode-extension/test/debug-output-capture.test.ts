import { describe, expect, test } from "bun:test";

import { DebugOutputCaptureStore } from "../src/debug-output-capture.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Debug Console output capture", () => {
  test("sanitizes, filters by category and pages only bounded public events", () => {
    let now = Date.parse("2026-08-10T12:00:00.000Z");
    const store = new DebugOutputCaptureStore(INSTANCE_ID, { now: () => now });
    store.start("debug-1", "Fixture debug", "file:///workspace");
    store.append("debug-1", "stdout", "\u001b[31mhello\u001b[0m\n", "src/main.ts", 2, 4);
    now += 100;
    store.append("debug-1", "stderr", "warning\n", null, null, null);

    const listed = store.list({ offset: 0, limit: 20, includeTerminated: true });
    expect(listed.sessions[0]).toMatchObject({
      debugSessionId: "debug-1",
      status: "active",
      coverage: "sinceActivation",
      eventCount: 2,
    });
    const read = store.read({
      debugSessionId: "debug-1",
      cursor: 0,
      maxChars: 200_000,
      categories: ["stdout"],
    });
    expect(read.events).toHaveLength(1);
    expect(read.events[0]).toMatchObject({ text: "hello\n", sourcePath: "src/main.ts", line: 2, character: 4 });
    expect(JSON.stringify(read)).not.toContain("\u001b");
  });

  test("reports dropped characters and expires ended sessions", () => {
    let now = Date.parse("2026-08-10T12:00:00.000Z");
    const store = new DebugOutputCaptureStore(INSTANCE_ID, {
      sessionBytes: 12,
      windowBytes: 12,
      retentionMs: 1_000,
      now: () => now,
    });
    store.start("debug-2", "Fixture debug", null);
    store.append("debug-2", "console", "0123456789abcdef", null, null, null);
    expect(store.list({ offset: 0, limit: 20, includeTerminated: true }).sessions[0]!.droppedCharacters).toBeGreaterThan(0);
    store.finish("debug-2");
    now += 1_001;
    expect(store.list({ offset: 0, limit: 20, includeTerminated: true }).sessions).toEqual([]);
  });

  test("preserves large output across cursor pages", () => {
    const store = new DebugOutputCaptureStore(INSTANCE_ID);
    const output = "x".repeat(2_400);
    store.start("debug-pages", "Paged debug", null);
    store.append("debug-pages", "console", output, null, null, null);

    const first = store.read({
      debugSessionId: "debug-pages",
      cursor: 0,
      maxChars: 1_024,
    });
    const second = store.read({
      debugSessionId: "debug-pages",
      cursor: first.nextCursor,
      maxChars: 1_024,
    });
    const third = store.read({
      debugSessionId: "debug-pages",
      cursor: second.nextCursor,
      maxChars: 1_024,
    });

    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    expect(third.truncated).toBe(false);
    expect([...first.events, ...second.events, ...third.events].map((event) => event.text).join(""))
      .toBe(output);
  });
});
