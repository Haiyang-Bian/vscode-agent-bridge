import { describe, expect, test } from "bun:test";

import {
  DiagnosticsParamsSchema,
  HoverParamsSchema,
  MAX_DOCUMENT_CHARACTERS,
  PositionedDocumentParamsSchema,
  ReadDocumentParamsSchema,
} from "../src/index.js";

describe("read-only language-service contracts", () => {
  test("applies bounded defaults for document reads", () => {
    const parsed = ReadDocumentParamsSchema.parse({});
    expect(parsed.maxChars).toBeGreaterThan(0);
    expect(() =>
      ReadDocumentParamsSchema.parse({ maxChars: MAX_DOCUMENT_CHARACTERS + 1 }),
    ).toThrow();
  });

  test("requires a URI for document diagnostics", () => {
    expect(() => DiagnosticsParamsSchema.parse({ scope: "document" })).toThrow();
    expect(
      DiagnosticsParamsSchema.parse({ scope: "document", uri: "file:///workspace/main.ts" }),
    ).toMatchObject({ scope: "document", uri: "file:///workspace/main.ts" });
  });

  test("rejects out-of-shape positioned requests", () => {
    expect(() =>
      PositionedDocumentParamsSchema.parse({
        uri: "file:///workspace/main.ts",
        position: { line: -1, character: 0 },
      }),
    ).toThrow();
  });

  test("applies a bounded hover default", () => {
    const parsed = HoverParamsSchema.parse({
      uri: "file:///workspace/main.ts",
      position: { line: 0, character: 0 },
    });
    expect(parsed.maxChars).toBeGreaterThan(0);
  });
});
