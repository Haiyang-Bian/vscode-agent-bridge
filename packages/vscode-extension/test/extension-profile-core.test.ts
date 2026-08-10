import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  GlobalProfileChangeJournal,
  assertConfigurationKeyAllowed,
  assertConfigurationTargetAllowed,
  assertConfigurationValueAllowed,
  configurationValueSha256,
  findDeclaredConfigurationSetting,
} from "../src/extension-profile-core.js";

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-profile-journal-"));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("declared current-Profile configuration", () => {
  test("accepts only manifest-declared types, enum values and supported targets", () => {
    const setting = findDeclaredConfigurationSetting(
      {
        contributes: {
          configuration: {
            properties: {
              "sample.mode": { type: "string", enum: ["safe", "fast"], scope: "resource" },
            },
          },
        },
      },
      "sample.mode",
    )!;

    expect(setting.types).toEqual(["string"]);
    expect(() => assertConfigurationTargetAllowed(setting, "workspaceFolder")).not.toThrow();
    expect(() => assertConfigurationValueAllowed(setting, "safe")).not.toThrow();
    expect(() => assertConfigurationValueAllowed(setting, 42)).toThrow();
    expect(() => assertConfigurationValueAllowed(setting, "unknown")).toThrow();
    expect(findDeclaredConfigurationSetting({}, "sample.mode")).toBeNull();
  });

  test("denies credential-like keys and hashes canonical values deterministically", () => {
    expect(() => assertConfigurationKeyAllowed("sample.apiKey")).toThrow();
    expect(() => assertConfigurationKeyAllowed("sample.passwordPath")).toThrow();
    expect(() => assertConfigurationKeyAllowed("sample.languageServer.enabled")).not.toThrow();
    expect(configurationValueSha256({ b: 2, a: 1 })).toBe(configurationValueSha256({ a: 1, b: 2 }));
    expect(configurationValueSha256(undefined)).not.toBe(configurationValueSha256(null));
  });

  test("persists a bounded local undo record without recording an undefined value", async () => {
    const journal = new GlobalProfileChangeJournal(temporaryRoot);
    const change = await journal.append({
      extensionId: "sample.extension",
      key: "sample.enabled",
      beforeDefined: false,
      beforeValue: null,
      afterValueSha256: configurationValueSha256(true),
    });
    expect((await journal.latest())?.changeId).toBe(change.changeId);
    await journal.remove(change.changeId);
    expect(await journal.latest()).toBeNull();
  });
});
