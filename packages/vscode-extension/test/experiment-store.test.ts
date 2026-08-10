import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    expect(await store.toExperimentInfo(await store.readManifest(manifest.sessionId))).toMatchObject({
      sessionId: manifest.sessionId,
      lifecycle: "active",
      managed: null,
    });
    expect((await store.addWarning(manifest.sessionId, "Informational Git warning", false)).health).toBe(
      "complete",
    );
    expect(manifest.schemaVersion).toBe(2);
    await expect(store.assertResourceHistorySupported(manifest.sessionId)).resolves.toMatchObject({
      schemaVersion: 2,
    });
  });

  test("reads legacy v1 manifests but refuses resource-history writes", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Legacy session",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
    });
    const manifestPath = path.join(directory, "sessions", manifest.sessionId, "manifest.json");
    const legacy = JSON.parse(await readFile(manifestPath, "utf8"));
    legacy.schemaVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect((await store.readManifest(manifest.sessionId)).schemaVersion).toBe(1);
    await expect(store.assertResourceHistorySupported(manifest.sessionId)).rejects.toMatchObject({
      code: "EXPERIMENT_UPGRADE_REQUIRED",
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

  test("renames ordinary experiments atomically with an expected-title precondition", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Initial title",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
    });

    const renamed = await store.renameOrdinaryExperiment(
      manifest.sessionId,
      "Initial title",
      "Task-derived title",
    );
    expect(renamed.title).toBe("Task-derived title");
    await expect(
      store.renameOrdinaryExperiment(manifest.sessionId, "Initial title", "Stale update"),
    ).rejects.toMatchObject({ code: "EXPERIMENT_STATE_CHANGED" });
    expect((await store.readManifest(manifest.sessionId)).title).toBe("Task-derived title");
  });

  test("preserves a rename across concurrent checkpoint metadata mutations", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Initial title",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "complete",
    });

    await Promise.all([
      store.renameOrdinaryExperiment(manifest.sessionId, "Initial title", "Renamed title"),
      store.appendCheckpoint(manifest.sessionId, {
        source: "explicit",
        summary: "Concurrent checkpoint",
        documents: [],
        coverageComplete: true,
      }),
      store.addStorageBytes(manifest.sessionId, 17),
      store.addWarning(manifest.sessionId, "Concurrent warning", false),
      store.addEvidence(manifest.sessionId, manifest.currentCheckpointId!, {
        evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        kind: "test",
        status: "passed",
        source: "client-reported",
        summary: "Concurrent evidence",
        createdAt: "2026-08-10T00:00:00.000Z",
      }),
    ]);

    const current = await store.readManifest(manifest.sessionId);
    expect(current).toMatchObject({
      title: "Renamed title",
      storageBytes: 17,
      warnings: ["Concurrent warning"],
      nextSequence: 2,
    });
    expect(current.checkpointIds).toHaveLength(2);
    await expect(
      store.renameOrdinaryExperiment(manifest.sessionId, "Initial title", "Stale overwrite"),
    ).rejects.toMatchObject({ code: "EXPERIMENT_STATE_CHANGED" });
  });

  test("does not expose managed experiment renaming through the ordinary metadata path", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "worktree",
      title: "Managed",
      rootUri: "file:///managed",
      workspaceIdentity: "managed",
      baseRevision: "a".repeat(40),
      branch: "vscode-agent-bridge/experiment/test",
      health: "complete",
    });
    await expect(
      store.renameOrdinaryExperiment(manifest.sessionId, "Managed", "Renamed"),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("stores managed metadata separately from checkpoint manifests", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const manifest = await store.createExperiment({
      sessionId,
      mode: "worktree",
      title: "Managed",
      rootUri: "file:///managed/session",
      workspaceIdentity: "managed",
      baseRevision: "a".repeat(40),
      branch: "vscode-agent-bridge/experiment/test",
      health: "complete",
    });
    await store.writeManagedMetadata(sessionId, {
      schemaVersion: 1,
      repositoryRoot: "C:/repository",
      worktreePath: "C:/managed/session",
      targetBranch: "main",
      baseHead: "a".repeat(40),
      experimentBranch: "vscode-agent-bridge/experiment/test",
      experimentHead: "a".repeat(40),
      acceptedCommit: null,
      formalCommit: null,
      state: "ready",
      syncTargetHead: null,
    });
    expect(await store.toExperimentInfo(manifest)).toMatchObject({
      mode: "worktree",
      managed: {
        targetBranch: "main",
        baseHead: "a".repeat(40),
        state: "ready",
      },
    });
    expect(JSON.parse(await readFile(path.join(directory, "sessions", sessionId, "manifest.json"), "utf8"))).not.toHaveProperty("repositoryRoot");
  });

  test("appends evidence without rewriting the checkpoint event", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Evidence test",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
    });
    const eventsDirectory = path.join(directory, "sessions", manifest.sessionId, "events");
    const checkpointFile = (await readdir(eventsDirectory)).find((file) => !file.includes("-evidence-"))!;
    const checkpointBefore = await readFile(path.join(eventsDirectory, checkpointFile), "utf8");
    await store.addEvidence(manifest.sessionId, manifest.currentCheckpointId!, {
      evidenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      kind: "test",
      status: "passed",
      source: "client-reported",
      summary: "Test passed",
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await readFile(path.join(eventsDirectory, checkpointFile), "utf8")).toBe(checkpointBefore);
    expect((await readdir(eventsDirectory)).filter((file) => file.includes("-evidence-"))).toHaveLength(1);
    expect((await store.readCheckpoint(manifest.sessionId, manifest.currentCheckpointId!)).evidence).toHaveLength(1);
  });

  test("serializes concurrent atomic replacements for one manifest", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    const manifest = await store.createExperiment({
      mode: "workspace",
      title: "Concurrent manifest writes",
      rootUri: "file:///workspace",
      workspaceIdentity: "workspace",
      baseRevision: null,
      branch: null,
      health: "partial",
    });

    await Promise.all(
      Array.from({ length: 32 }, (_, index) => store.setPinned(manifest.sessionId, index % 2 === 0)),
    );

    expect((await store.readManifest(manifest.sessionId)).sessionId).toBe(manifest.sessionId);
    expect(
      (await readdir(path.join(directory, "sessions", manifest.sessionId))).filter((file) =>
        file.endsWith(".tmp"),
      ),
    ).toEqual([]);
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
    const recovered = new ExperimentStore(directory, INSTANCE_A);
    await recovered.initialize();
    expect((await recovered.readManifest(manifest.sessionId)).health).toBe("corrupt");
    expect(await recovered.getStats()).toMatchObject({ sessionCount: 1, corruptCount: 1 });
    await recovered.collectUnreferencedBlobs();
    const blobPath = path.join(directory, "blobs", "sha256", blob.sha256.slice(0, 2), `${blob.sha256}.gz`);
    expect((await readFile(blobPath)).length).toBeGreaterThan(0);
  });

  test("deletes expired ended sessions and garbage-collects only unreferenced blobs", async () => {
    const directory = await temporaryDirectory();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new ExperimentStore(directory, INSTANCE_A, {
      now: () => now,
      retentionDays: 1,
    });
    const removedBlob = await store.putBlob("remove me");
    const retainedBlob = await store.putBlob("retain me");
    const expired = await store.createExperiment({
      mode: "workspace",
      title: "Expired",
      rootUri: "file:///expired",
      workspaceIdentity: "expired",
      baseRevision: null,
      branch: null,
      health: "partial",
      baselineDocuments: [document(removedBlob.sha256)],
    });
    await store.addStorageBytes(expired.sessionId, removedBlob.storedBytes);
    await store.setLifecycle(expired.sessionId, "abandoned");
    const retained = await store.createExperiment({
      mode: "workspace",
      title: "Retained",
      rootUri: "file:///retained",
      workspaceIdentity: "retained",
      baseRevision: null,
      branch: null,
      health: "partial",
      baselineDocuments: [document(retainedBlob.sha256)],
    });
    await store.addStorageBytes(retained.sessionId, retainedBlob.storedBytes);
    await store.setPinned(retained.sessionId, true);
    await store.setLifecycle(retained.sessionId, "abandoned");

    now = new Date("2026-02-01T00:00:00.000Z");
    await store.enforceRetention();
    expect((await store.listManifests()).map((item) => item.sessionId)).toEqual([retained.sessionId]);
    await expect(stat(blobPath(directory, removedBlob.sha256))).rejects.toThrow();
    expect((await stat(blobPath(directory, retainedBlob.sha256))).isFile()).toBe(true);
  });

  test("rejects oversized, binary, malformed hash and path-traversal inputs", async () => {
    const directory = await temporaryDirectory();
    const store = new ExperimentStore(directory, INSTANCE_A);
    await expect(store.putBlob("x\0y")).rejects.toThrow("Binary");
    await expect(store.putBlob("x".repeat(2 * 1024 * 1024 + 1))).rejects.toThrow("size limit");
    await expect(store.readBlob("../outside")).rejects.toThrow();
    await expect(store.readManifest("../../outside")).rejects.toThrow();
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

function blobPath(directory: string, sha256: string): string {
  return path.join(directory, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.gz`);
}
