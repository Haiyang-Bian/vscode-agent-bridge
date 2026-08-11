import { describe, expect, test } from "bun:test";

import {
  DiagnosticsParamsSchema,
  HoverParamsSchema,
  LocationItemSchema,
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

  test("carries exact nullable provider-derived grants on locations", () => {
    expect(LocationItemSchema.parse({
      uri: "vscode-agent-bridge-external:/library.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
      accessGrantId: "11111111-1111-4111-8111-111111111111",
      accessGrantExpiresAt: "2026-08-11T00:10:00.000Z",
    })).toMatchObject({ accessGrantId: "11111111-1111-4111-8111-111111111111" });
  });
});
