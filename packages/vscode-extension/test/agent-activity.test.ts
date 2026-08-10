import { describe, expect, test } from "bun:test";

import { BridgeError } from "@vscode-agent-bridge/protocol";

import { AgentActivityTracker } from "../src/agent-activity.js";

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
});
