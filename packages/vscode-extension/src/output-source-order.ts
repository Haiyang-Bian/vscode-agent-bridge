import type {
  ListOutputSourcesParams,
  OutputSource,
} from "@vscode-agent-bridge/protocol";

export function selectAndSortOutputSources(
  sources: readonly OutputSource[],
  sourceTypes: ListOutputSourcesParams["sourceTypes"],
): OutputSource[] {
  const selected = sourceTypes
    ? sources.filter((source) => sourceTypes.includes(source.sourceType))
    : sources.filter((source) => source.sourceType !== "extensionCapability");
  return selected.sort((left, right) =>
    Number(right.canReadNow) - Number(left.canReadNow) ||
    activityRank(left.status) - activityRank(right.status) ||
    observedAt(right.lastObservedAt) - observedAt(left.lastObservedAt) ||
    left.label.localeCompare(right.label),
  );
}

function activityRank(status: OutputSource["status"]): number {
  if (status === "active" || status === "emitting") return 0;
  if (status === "available") return 1;
  return 2;
}

function observedAt(value: string | null): number {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}
