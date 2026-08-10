import { describe, expect, test } from "bun:test";

import { normalizeReviewedPythonEnvironment } from "../src/python-environment-integration-core.js";

describe("official Python environment adapter normalization", () => {
  test("returns only the reviewed active-environment fields", () => {
    expect(normalizeReviewedPythonEnvironment({
      interpreterPath: "C:\\Python312\\python.exe",
      environmentType: "VirtualEnvironment",
      environmentName: ".venv",
      version: {
        major: 3,
        minor: 12,
        micro: 7,
        release: { level: "final", serial: 0 },
      },
      architecture: "64-bit",
    })).toEqual({
      interpreterPath: "C:\\Python312\\python.exe",
      environmentType: "VirtualEnvironment",
      environmentName: ".venv",
      version: {
        major: 3,
        minor: 12,
        micro: 7,
        releaseLevel: "final",
        releaseSerial: 0,
      },
      architecture: "64-bit",
    });
  });

  test("does not invent unresolved metadata", () => {
    expect(normalizeReviewedPythonEnvironment({})).toEqual({
      interpreterPath: null,
      environmentType: null,
      environmentName: null,
      version: null,
      architecture: null,
    });
  });
});
