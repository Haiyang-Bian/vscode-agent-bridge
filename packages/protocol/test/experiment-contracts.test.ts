import { describe, expect, test } from "bun:test";

import {
  MAX_CHANGE_SET_DOCUMENTS,
  ManagedExperimentInfoSchema,
  PrepareRenameInputSchema,
  PrepareTextEditsInputSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);

describe("experiment contracts", () => {
  test("requires explicit instance and session IDs for guarded writes", () => {
    expect(() =>
      PrepareRenameInputSchema.parse({
        sessionId: SESSION_ID,
        title: "Rename",
        uri: "file:///workspace/main.ts",
        position: { line: 0, character: 0 },
        newName: "renamed",
        expectedSha256: HASH,
      }),
    ).toThrow();

    expect(
      PrepareRenameInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        title: "Rename",
        uri: "file:///workspace/main.ts",
        position: { line: 0, character: 0 },
        newName: "renamed",
        expectedSha256: HASH,
      }),
    ).toMatchObject({ instanceId: INSTANCE_ID, sessionId: SESSION_ID });
  });

  test("rejects overlapping edits and duplicate documents", () => {
    const document = {
      uri: "file:///workspace/main.ts",
      expectedSha256: HASH,
      edits: [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          newText: "one",
        },
        {
          range: {
            start: { line: 0, character: 2 },
            end: { line: 0, character: 4 },
          },
          newText: "two",
        },
      ],
    };
    expect(() =>
      PrepareTextEditsInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        title: "Edit",
        documents: [document],
      }),
    ).toThrow();
    expect(() =>
      PrepareTextEditsInputSchema.parse({
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        title: "Edit",
        documents: [
          { ...document, edits: [document.edits[0]] },
          { ...document, edits: [document.edits[0]] },
        ],
      }),
    ).toThrow();
  });

  test("bounds document count", () => {
    expect(MAX_CHANGE_SET_DOCUMENTS).toBe(50);
  });

  test("models managed worktree promotion without exposing paths", () => {
    const managed = ManagedExperimentInfoSchema.parse({
      targetBranch: "main",
      baseHead: "a".repeat(40),
      experimentBranch: "vscode-agent-bridge/experiment/test",
      experimentHead: "b".repeat(40),
      acceptedCommit: "b".repeat(40),
      formalCommit: null,
      state: "ready",
    });
    expect(managed).not.toHaveProperty("repositoryRoot");
    expect(managed).not.toHaveProperty("worktreePath");
  });
});
