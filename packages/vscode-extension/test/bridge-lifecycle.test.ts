import { describe, expect, test } from "bun:test";

import { initializePublishedBridge } from "../src/bridge-lifecycle.js";

describe("published bridge lifecycle", () => {
  test("publishes initializing before waiting for slow storage", async () => {
    const events: string[] = [];
    let releaseStorage!: () => void;
    const storage = new Promise<void>((resolve) => { releaseStorage = resolve; });
    const lifecycle = initializePublishedBridge(
      {
        markReady: async () => { events.push("ready"); },
        markDegraded: async () => { events.push("degraded"); },
      },
      async () => { events.push("initializing"); },
      async () => { events.push("storage-started"); await storage; },
      () => { events.push("reported"); },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["initializing", "storage-started"]);
    releaseStorage();
    await lifecycle;
    expect(events).toEqual(["initializing", "storage-started", "ready"]);
  });

  test("publishes degraded when storage initialization fails", async () => {
    const events: string[] = [];
    await initializePublishedBridge(
      {
        markReady: async () => { events.push("ready"); },
        markDegraded: async () => { events.push("degraded"); },
      },
      async () => { events.push("initializing"); },
      async () => { throw new Error("corrupt storage"); },
      (error) => { events.push((error as Error).message); },
    );
    expect(events).toEqual(["initializing", "degraded", "corrupt storage"]);
  });
});
