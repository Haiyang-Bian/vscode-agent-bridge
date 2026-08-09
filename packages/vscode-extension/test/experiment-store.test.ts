import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  EXPERIMENT_LEASE_STALE_MS,
  ExperimentStore,
  type StoredDocument,
} from "../src/experiment-store.js";

const INSTANCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("experiment store", () => {
  test("deduplicates blobs and persists checkpoints", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const firstBlob = await store.putBlob("const answer = 42;\n");
    const secondBlob = await store.putBlob("const answer = 42;\n");
    expect(firstBlob.created).toBe(true);
    expect(secondBlob).toMatchObject({ sha256: firstBlob.sha256, created: false });
    expect(await store.readBlob(firstBlob.sha256)).toBe("const answer = 42;\n");

    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Store test",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: "a".repeat(40),
      branch: "main",
      health: "complete",
      baselineDocuments: [document(firstBlob.sha256)],
    });
    await store.addStorageBytes(manifest.sessionId, firstBlob.storedBytes);
    const checkpoints = await store.listCheckpoints(manifest.sessionId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.documents[0]?.blobSha256).toBe(firstBlob.sha256);
    expect(store.toExperimentInfo(await store.readManifest(manifest.sessionId))).toMatchObject({
      sessionId: manifest.sessionId,
      lifecycle: "active",
    });
  });

  test("prevents two live instances from owning one experiment", async () => {
    const directory = await temporaryDirectory();
    let now = new Date("2026-08-09T00:00:00.000Z");
    const storeA = new ExperimentStore(directory, INSTANCE_A, { now: () => now });
    const manifest = await storeA.createExperiment({
      mode: "workspace",
      title: "Lease test",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
    });
    const storeB = new ExperimentStore(directory, INSTANCE_B, { now: () => now });
    await expect(storeB.acquireLease(manifest.sessionId)).rejects.toThrow();

    now = new Date(now.getTime() + EXPERIMENT_LEASE_STALE_MS + 1);
    await storeB.acquireLease(manifest.sessionId);
    await expect(storeA.assertLease(manifest.sessionId)).rejects.toThrow();
  });

  test("does not retention-delete active or pinned sessions", async () => {
    const directory = await temporaryDirectory();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new ExperimentStore(directory, INSTANCE_A, {
      now: () => now,
      retentionDays: 1,
      storageLimitBytes: 0,
    });
    const active = await store.createExperiment({
      mode: "workspace",
      title: "Active",
      rootUri: "file:///active",
      workspaceIdentity: "active",
      baseRevision: null,
      branch: null,
      health: "partial",
    });
    const pinned = await store.createExperiment({
      mode: "workspace",
      title: "Pinned",
      rootUri: "file:///pinned",
      workspaceIdentity: "pinned",
      baseRevision: null,
      branch: null,
      health: "partial",
    });
    await store.setPinned(pinned.sessionId, true);
    await store.setLifecycle(pinned.sessionId, "abandoned");
    now = new Date("2026-02-01T00:00:00.000Z");
    await store.enforceRetention();
    expect((await store.listManifests()).map((item) => item.sessionId).sort()).toEqual(
      [active.sessionId, pinned.sessionId].sort(),
    );
  });

  test("keeps blobs when a session event is corrupt", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const blob = await store.putBlob("keep me");
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Corrupt",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
      baselineDocuments: [document(blob.sha256)],
    });
    const eventsDirectory = path.join(directory, "sessions", manifest.sessionId, "events");
    const eventFile = (await import("node:fs/promises")).readdir(eventsDirectory).then((files) => files[0]!);
    await writeFile(path.join(eventsDirectory, await eventFile), "not json", "utf8");
    await store.collectUnreferencedBlobs();
    const blobPath = path.join(directory, "blobs", "sha256", blob.sha256.slice(0, 2), `${blob.sha256}.gz`);
    expect((await readFile(blobPath)).length).toBeGreaterThan(0);
  });
});

function document(sha256: string): StoredDocument {
  return {
    uri: "file:///workspace/main.ts",
    languageId: "typescript",
    documentVersion: 1,
    isDirty: false,
    exists: true,
    blobSha256: sha256,
    contentSha256: sha256,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vscode-agent-bridge-store-"));
  directories.push(directory);
  return directory;
}
