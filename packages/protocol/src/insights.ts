import { z } from "zod";

import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_DOMAINS,
  type McpToolCatalogEntry,
  type McpToolDomain,
  type McpToolName,
} from "./tool-catalog.js";

export const UsageOutcomeSchema = z.enum(["success", "no-op", "rejected", "failed"]);
export const UsageLatencyBucketSchema = z.enum([
  "under10ms",
  "under100ms",
  "under1s",
  "under10s",
  "over10s",
]);
export const UsageSizeBucketSchema = z.enum([
  "empty",
  "under1KiB",
  "under16KiB",
  "under256KiB",
  "over256KiB",
]);

export const UsageInsightEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    processSessionId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    toolName: z.string().min(1),
    domain: z.enum(Object.keys(MCP_TOOL_DOMAINS) as [McpToolDomain, ...McpToolDomain[]]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    outcome: UsageOutcomeSchema,
    latencyBucket: UsageLatencyBucketSchema,
    requestSizeBucket: UsageSizeBucketSchema,
    resultSizeBucket: UsageSizeBucketSchema,
    truncated: z.boolean(),
    errorCode: z.string().min(1).nullable(),
  })
  .strict();

export const GetBridgeCapabilitiesInputSchema = z.object({}).strict();
export const BridgeCapabilityToolSchema = z
  .object({
    name: z.string().min(1),
    domain: z.enum(Object.keys(MCP_TOOL_DOMAINS) as [McpToolDomain, ...McpToolDomain[]]),
    domainLabel: z.string().min(1),
    intent: z.enum(["observe", "prepare", "act", "control"]),
    sideEffectScope: z.enum(["none", "memory", "workspace", "process", "debuggee"]),
    requiresExperiment: z.boolean(),
    recoverability: z.enum(["full", "partial", "none", "notApplicable"]),
    openWorld: z.boolean(),
    sensitivity: z.enum(["public", "workspaceMetadata", "source", "terminal", "debug"]),
    annotations: z
      .object({
        readOnlyHint: z.boolean(),
        destructiveHint: z.boolean(),
        idempotentHint: z.boolean(),
        openWorldHint: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const BridgeCapabilitiesResultSchema = z
  .object({
    releaseVersion: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    toolCount: z.number().int().nonnegative(),
    tools: z.array(BridgeCapabilityToolSchema),
  })
  .strict();

export const GetUsageInsightsInputSchema = z
  .object({
    days: z.number().int().min(1).max(30).default(30),
  })
  .strict();

const CountByNameSchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const UsageInsightsResultSchema = z
  .object({
    generatedAt: z.string().datetime(),
    windowDays: z.number().int().min(1).max(30),
    localOnly: z.literal(true),
    totalCalls: z.number().int().nonnegative(),
    categories: z.array(CountByNameSchema),
    tools: z.array(CountByNameSchema),
    outcomes: z.array(CountByNameSchema),
    friction: z.array(CountByNameSchema),
    workflowClosures: z
      .object({
        prepared: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        saved: z.number().int().nonnegative(),
        validated: z.number().int().nonnegative(),
        checkpointed: z.number().int().nonnegative(),
      })
      .strict(),
    suggestions: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

export type UsageInsightEvent = z.infer<typeof UsageInsightEventSchema>;
export type UsageInsightsResult = z.infer<typeof UsageInsightsResultSchema>;

export function publicToolCatalog(): Array<McpToolCatalogEntry & { readonly domainLabel: string }> {
  return MCP_TOOL_CATALOG.map((tool) => ({
    ...tool,
    domainLabel: MCP_TOOL_DOMAINS[tool.domain],
  }));
}

export function aggregateUsageInsights(
  events: readonly UsageInsightEvent[],
  windowDays: number,
  now = new Date(),
): UsageInsightsResult {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1_000;
  const selected = events.filter((event) => Date.parse(event.finishedAt) >= cutoff);
  const categories = countBy(selected.map((event) => event.domain));
  const tools = countBy(selected.map((event) => event.toolName));
  const outcomes = countBy(selected.map((event) => event.outcome));
  const friction = countBy(
    selected.flatMap((event) => [
      ...(event.errorCode ? [event.errorCode] : []),
      ...(event.truncated ? ["RESULT_TRUNCATED"] : []),
      ...(event.latencyBucket === "over10s" ? ["SLOW_OVER_10_SECONDS"] : []),
    ]),
  );
  const names = new Set(selected.map((event) => event.toolName));
  const workflowClosures = {
    prepared: countMatching(selected, ["vscode_prepare_text_edits", "vscode_prepare_rename", "vscode_prepare_resource_changes", "vscode_list_code_actions"]),
    applied: countMatching(selected, ["vscode_apply_change_set", "vscode_apply_code_action", "vscode_format_document"]),
    saved: countMatching(selected, ["vscode_save_document"]),
    validated: countMatching(selected, ["vscode_run_task"]),
    checkpointed: countMatching(selected, ["vscode_create_experiment_checkpoint"]),
  };

  const suggestions: string[] = [];
  const staleCount = selected.filter((event) => event.errorCode?.includes("STALE") === true).length;
  const truncatedCount = selected.filter((event) => event.truncated).length;
  if (staleCount >= 3) {
    suggestions.push(`${staleCount} stale-state rejections occurred; refresh document hashes or fingerprints immediately before acting.`);
  }
  if (truncatedCount >= 3) {
    suggestions.push(`${truncatedCount} results were truncated; use narrower filters or cursor pagination.`);
  }
  if (workflowClosures.applied > workflowClosures.saved && names.has("vscode_save_document")) {
    suggestions.push("More edit workflows were applied than saved; verify whether dirty buffers are intentional before validation.");
  }
  if (workflowClosures.validated > workflowClosures.checkpointed) {
    suggestions.push("Validated workflows outnumber explicit checkpoints; consider checkpointing stable candidates after successful tasks or tests.");
  }

  return {
    generatedAt: now.toISOString(),
    windowDays,
    localOnly: true,
    totalCalls: selected.length,
    categories,
    tools,
    outcomes,
    friction,
    workflowClosures,
    suggestions,
  };
}

function countMatching(events: readonly UsageInsightEvent[], names: readonly McpToolName[]): number {
  const accepted = new Set<string>(names);
  return events.filter((event) => event.outcome !== "failed" && accepted.has(event.toolName)).length;
}

function countBy(values: readonly string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}
