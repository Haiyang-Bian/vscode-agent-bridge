export const OFFICIAL_EXTENSION_MAINTAINER_DIRECTORY_VERSION = "2026-08-10";

const OFFICIAL_PUBLISHERS = new Set([
  "github",
  "microsoft",
  "ms-azuretools",
  "ms-dotnettools",
  "ms-python",
  "ms-toolsai",
  "ms-vscode",
]);

export function isOfficialExtensionPublisher(publisher: string): boolean {
  return OFFICIAL_PUBLISHERS.has(publisher.trim().toLowerCase());
}
