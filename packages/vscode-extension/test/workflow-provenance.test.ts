import { describe, expect, test } from "bun:test";

import { WorkflowProvenanceStore } from "../src/workflow-provenance.js";

class MemoryMemento {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

describe("Task and Debug workflow provenance", () => {
  test("serializes same-name replacements and retains fingerprinted Task bindings", async () => {
    const memento = new MemoryMemento();
    const store = new WorkflowProvenanceStore(memento);
    const rootUri = "file:///workspace";
    await Promise.all([
      store.record({
        kind: "debug",
        preparedId: "first",
        rootUri,
        name: "Launch Agent",
        definitionFingerprint: "old",
        configurationSha256: "config-old",
        createdAt: "2026-08-11T00:00:00.000Z",
      }),
      store.record({
        kind: "debug",
        preparedId: "second",
        rootUri,
        name: "Launch Agent",
        definitionFingerprint: "new",
        configurationSha256: "config-new",
        createdAt: "2026-08-11T00:01:00.000Z",
        taskBindings: {
          preLaunchTask: { taskId: "task", expectedFingerprint: "task-fingerprint" },
          postDebugTask: null,
        },
      }),
    ]);

    expect(store.entries("debug", rootUri)).toHaveLength(1);
    expect(store.find("debug", rootUri, "Launch Agent", "new")).toMatchObject({
      preparedId: "second",
      taskBindings: {
        preLaunchTask: { taskId: "task", expectedFingerprint: "task-fingerprint" },
      },
    });
    expect(store.find("debug", rootUri, "Launch Agent", "old")).toBeNull();
  });

  test("ignores malformed workspaceStorage data", () => {
    const memento = new MemoryMemento();
    memento.values.set("vscodeAgentBridge.workflowProvenance.v1", [
      { kind: "task", preparedId: "incomplete" },
      "not-an-entry",
    ]);
    expect(new WorkflowProvenanceStore(memento).entries("task", "file:///workspace")).toEqual([]);
  });

  test("rebases sibling provenance only from the exact previous configuration hash", async () => {
    const memento = new MemoryMemento();
    const store = new WorkflowProvenanceStore(memento);
    const rootUri = "file:///workspace";
    await store.record({
      kind: "task",
      preparedId: "one",
      rootUri,
      name: "One",
      definitionFingerprint: "one",
      configurationSha256: "before",
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    await store.recordConfigurationWrite({
      kind: "task",
      preparedId: "two",
      rootUri,
      name: "Two",
      definitionFingerprint: "two",
      configurationSha256: "after",
      createdAt: "2026-08-11T00:01:00.000Z",
    }, "before");

    expect(store.find("task", rootUri, "One")?.configurationSha256).toBe("after");
    expect(store.find("task", rootUri, "Two")?.configurationSha256).toBe("after");
  });
});
