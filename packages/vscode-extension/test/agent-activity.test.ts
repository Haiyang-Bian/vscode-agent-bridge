import { describe, expect, test } from "bun:test";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "../src/agent-activity.js";
import { planEditorReveal } from "../src/editor-visibility-plan.js";

describe("Agent activity tracker", () => {
  test("records bounded success and no-op summaries without absolute targets", async () => {
    const tracker = new AgentActivityTracker(2);
    await tracker.track(
      {
        toolName: "vscode_format_document",
        title: "Format document",
        reason: "Normalize\nformatting",
        targets: ["C:/private/workspace/secret.ts"],
      },
      async () => ({ applied: false }),
      () => ({ status: "no-op", editCount: 0 }),
    );
    expect(tracker.entries[0]).toMatchObject({
      status: "no-op",
      reason: "Normalize formatting",
      targets: ["secret.ts"],
      editCount: 0,
    });

    await tracker.track({ toolName: "one", title: "One" }, async () => 1);
    await tracker.track({ toolName: "two", title: "Two" }, async () => 2);
    expect(tracker.entries).toHaveLength(2);
    expect(tracker.entries.map((entry) => entry.title)).toEqual(["Two", "One"]);
  });

  test("separates policy rejection from unexpected failure", async () => {
    const tracker = new AgentActivityTracker();
    await expect(
      tracker.track({ toolName: "write", title: "Denied" }, async () => {
        throw new BridgeError("POLICY_DENIED", "Denied");
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(tracker.entries[0]).toMatchObject({
      status: "rejected",
      errorCode: "POLICY_DENIED",
    });

    await expect(
      tracker.track({ toolName: "write", title: "Failed" }, async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(tracker.entries[0]).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
  });

  test("records asynchronous workflow transitions without retaining commands or paths", () => {
    const tracker = new AgentActivityTracker(2);
    tracker.record(
      {
        toolName: "vscode_run_task",
        title: "Task running: test",
        targets: ["C:/private/project/tasks.json"],
      },
      "running",
    );
    tracker.record(
      { toolName: "vscode_run_task", title: "Task ended: test" },
      "succeeded",
    );
    expect(tracker.entries).toHaveLength(2);
    expect(tracker.entries[0]).toMatchObject({ status: "succeeded", completedAt: expect.any(String) });
    expect(tracker.entries[1]).toMatchObject({ status: "running", targets: ["tasks.json"] });
  });
});

describe("Agent editor visibility plan", () => {
  test("covers every configured presentation without changing target order semantics", () => {
    const targets = ["first", "second", "third"];
    expect(planEditorReveal("focusFirst", targets)).toEqual([
      { target: "second", preserveFocus: true },
      { target: "third", preserveFocus: true },
      { target: "first", preserveFocus: false },
    ]);
    expect(planEditorReveal("focusEach", targets)).toEqual(
      targets.map((target) => ({ target, preserveFocus: false })),
    );
    expect(planEditorReveal("firstOnly", targets)).toEqual([
      { target: "first", preserveFocus: false },
    ]);
    expect(planEditorReveal("off", targets)).toEqual([]);
  });
});
