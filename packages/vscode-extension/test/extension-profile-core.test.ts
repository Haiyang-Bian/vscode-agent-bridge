import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      beforeValueSha256: configurationValueSha256(undefined),
      afterValueSha256: configurationValueSha256(true),
    });
    expect((await journal.latest())?.changeId).toBe(change.changeId);
    expect((await journal.latest())?.state).toBe("committed");
    await journal.remove(change.changeId);
    expect(await journal.latest()).toBeNull();
  });

  test("recovers pending state from exact before/after hashes and flags ambiguity", async () => {
    const journal = new GlobalProfileChangeJournal(temporaryRoot);
    const before = configurationValueSha256(false);
    const after = configurationValueSha256(true);
    const applied = await journal.begin({
      extensionId: "sample.extension",
      key: "sample.enabled",
      beforeDefined: true,
      beforeValue: false,
      beforeValueSha256: before,
      afterValueSha256: after,
    });
    expect((await journal.health()).pendingCount).toBe(1);
    expect((await journal.recover(async () => after)).healthy).toBeTrue();
    expect((await journal.latest())?.changeId).toBe(applied.changeId);

    await journal.begin({
      extensionId: "sample.extension",
      key: "sample.mode",
      beforeDefined: true,
      beforeValue: "safe",
      beforeValueSha256: configurationValueSha256("safe"),
      afterValueSha256: configurationValueSha256("fast"),
    });
    const health = await journal.recover(async (change) =>
      change.key === "sample.mode" ? configurationValueSha256("manual") : after,
    );
    expect(health.attentionRequiredCount).toBe(1);
    expect(health.healthy).toBeFalse();
  });

  test("serializes concurrent pending writes without dropping entries", async () => {
    const journal = new GlobalProfileChangeJournal(temporaryRoot);
    await Promise.all(Array.from({ length: 20 }, (_, index) => journal.begin({
      extensionId: "sample.extension",
      key: `sample.${index}`,
      beforeDefined: false,
      beforeValue: null,
      beforeValueSha256: configurationValueSha256(undefined),
      afterValueSha256: configurationValueSha256(index),
    })));
    expect((await journal.health()).pendingCount).toBe(20);
  });

  test("fails closed and reports attention for a malformed journal", async () => {
    const directory = path.join(temporaryRoot, "extension-profile-changes", "v1");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "journal.json"), "{malformed", "utf8");
    const journal = new GlobalProfileChangeJournal(temporaryRoot);
    expect(await journal.health()).toEqual({
      pendingCount: 0,
      attentionRequiredCount: 1,
      healthy: false,
    });
    await expect(journal.begin({
      extensionId: "sample.extension",
      key: "sample.enabled",
      beforeDefined: false,
      beforeValue: null,
      beforeValueSha256: configurationValueSha256(undefined),
      afterValueSha256: configurationValueSha256(true),
    })).rejects.toThrow("requires user attention");
  });
});
