import { describe, expect, test } from "bun:test";

import { resolveReleaseTag } from "./release-environment.ts";

describe("release environment", () => {
  test("does not treat a pull request merge ref as a release tag", () => {
    expect(
      resolveReleaseTag({
        GITHUB_REF_NAME: "1/merge",
        GITHUB_REF_TYPE: "branch",
      }),
    ).toBeUndefined();
  });

  test("uses GitHub tag refs and explicit release tags", () => {
    expect(
      resolveReleaseTag({
        GITHUB_REF_NAME: "v0.2.0",
        GITHUB_REF_TYPE: "tag",
      }),
    ).toBe("v0.2.0");
    expect(
      resolveReleaseTag({
        RELEASE_TAG: "v0.2.0",
        GITHUB_REF_NAME: "not-the-release",
        GITHUB_REF_TYPE: "branch",
      }),
    ).toBe("v0.2.0");
  });
});
