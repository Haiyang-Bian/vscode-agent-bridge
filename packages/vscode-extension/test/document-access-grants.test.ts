import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_ACCESS_GRANT_TTL_MS,
  MAX_DOCUMENT_ACCESS_GRANTS,
} from "@vscode-agent-bridge/protocol";

import { DocumentAccessGrantStore } from "../src/document-access-grants.js";

describe("provider-derived document access grants", () => {
  test("authorizes only the exact URI on the issuing instance and expires deterministically", () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const store = new DocumentAccessGrantStore("11111111-1111-4111-8111-111111111111", () => now);
    const grant = store.issue("file:///outside/library.ts", "file:///workspace");
    expect(store.authorize(grant.accessGrantId, grant.uri)).toEqual(grant);
    expect(() => store.authorize(grant.accessGrantId, "file:///outside/other.ts")).toThrow();
    now += DOCUMENT_ACCESS_GRANT_TTL_MS;
    expect(() => store.authorize(grant.accessGrantId, grant.uri)).toThrow("expired");
  });

  test("keeps only the newest bounded grants", () => {
    let now = 0;
    const store = new DocumentAccessGrantStore("22222222-2222-4222-8222-222222222222", () => now++);
    for (let index = 0; index < MAX_DOCUMENT_ACCESS_GRANTS + 5; index += 1) {
      store.issue(`untitled:external-${index}`, "file:///workspace");
    }
    expect(store.size).toBe(MAX_DOCUMENT_ACCESS_GRANTS);
  });
});
