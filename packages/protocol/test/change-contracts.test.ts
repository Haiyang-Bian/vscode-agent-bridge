import { describe, expect, test } from "bun:test";

import {
  ApplyChangeSetInputSchema,
  CHANGE_SET_TTL_MS,
  GetWorkspaceSetupInputSchema,
  MAX_CHANGE_SET_DOCUMENTS,
  PrepareRenameInputSchema,
  PrepareTextEditsInputSchema,
  PreparedChangeSetSchema,
} from "../src/index.js";

const INSTANCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANGE_SET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);

describe("direct change contracts", () => {
  test("requires explicit instance and document preconditions without an experiment", () => {
    const input = {
      instanceId: INSTANCE_ID,
      rootUri: "file:///workspace",
      uri: "file:///workspace/main.ts",
      position: { line: 0, character: 0 },
      newName: "renamed",
      expectedSha256: HASH,
    };
    expect(PrepareRenameInputSchema.parse(input)).toEqual(input);
    expect(() => PrepareRenameInputSchema.parse({ ...input, instanceId: undefined })).toThrow();
    expect(() => PrepareRenameInputSchema.parse({ ...input, sessionId: CHANGE_SET_ID })).toThrow();
  });

  test("rejects overlapping edits and duplicate documents", () => {
    const document = {
      uri: "file:///workspace/main.ts",
      expectedSha256: HASH,
      edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "one" },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "two" },
      ],
    };
    expect(() => PrepareTextEditsInputSchema.parse({ instanceId: INSTANCE_ID, rootUri: "file:///workspace", documents: [document] })).toThrow();
    expect(() => PrepareTextEditsInputSchema.parse({
      instanceId: INSTANCE_ID,
      rootUri: "file:///workspace",
      documents: [
        { ...document, edits: [document.edits[0]] },
        { ...document, edits: [document.edits[0]] },
      ],
    })).toThrow();
  });

  test("keeps one-use prepared handles independent of global session state", () => {
    expect(ApplyChangeSetInputSchema.parse({ instanceId: INSTANCE_ID, changeSetId: CHANGE_SET_ID }))
      .toEqual({ instanceId: INSTANCE_ID, changeSetId: CHANGE_SET_ID });
    expect(PreparedChangeSetSchema.parse({
      instanceId: INSTANCE_ID,
      rootUri: "file:///workspace",
      changeSetId: CHANGE_SET_ID,
      kind: "text-edits",
      createdAt: "2026-09-16T00:00:00.000Z",
      expiresAt: "2026-09-16T00:10:00.000Z",
      documents: [],
      resources: [],
      editCount: 0,
      resourceOperationCount: 0,
      replacementCharacters: 0,
    })).not.toHaveProperty("sessionId");
    expect(CHANGE_SET_TTL_MS).toBe(600_000);
    expect(MAX_CHANGE_SET_DOCUMENTS).toBe(50);
  });

  test("workspace setup is reflection without experiment onboarding", () => {
    expect(GetWorkspaceSetupInputSchema.parse({})).toEqual({});
  });
});
