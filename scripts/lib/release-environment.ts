export function resolveReleaseTag(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (environment.RELEASE_TAG) {
    return environment.RELEASE_TAG;
  }

  return environment.GITHUB_REF_TYPE === "tag" ? environment.GITHUB_REF_NAME : undefined;
}
