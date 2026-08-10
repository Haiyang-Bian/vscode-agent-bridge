import { randomUUID } from "node:crypto";
import path from "node:path";

import { BridgeError } from "@vscode-agent-bridge/protocol";

export type AgentActivityStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "no-op"
  | "rejected"
  | "failed";

export interface AgentActivityEntry {
  readonly operationId: string;
  readonly toolName: string;
  readonly title: string;
  readonly reason: string | null;
  readonly status: AgentActivityStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly targets: readonly string[];
  readonly fileCount: number | null;
  readonly editCount: number | null;
  readonly checkpointId: string | null;
  readonly errorCode: string | null;
}

export interface AgentActivityInput {
  readonly toolName: string;
  readonly title: string;
  readonly reason?: string | null;
  readonly targets?: readonly string[];
}

export interface AgentActivityCompletion {
  readonly status?: "succeeded" | "no-op";
  readonly targets?: readonly string[];
  readonly fileCount?: number | null;
  readonly editCount?: number | null;
  readonly checkpointId?: string | null;
}

export class AgentActivityTracker {
  readonly #limit: number;
  readonly #listeners = new Set<() => void>();
  readonly #entries: AgentActivityEntry[] = [];

  constructor(limit = 200) {
    this.#limit = Math.max(1, limit);
  }

  get entries(): readonly AgentActivityEntry[] {
    return this.#entries.map((entry) => ({ ...entry, targets: [...entry.targets] }));
  }

  subscribe(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  async track<Result>(
    input: AgentActivityInput,
    operation: () => Promise<Result>,
    summarize: (result: Result) => AgentActivityCompletion = () => ({}),
  ): Promise<Result> {
    const operationId = randomUUID();
    this.#entries.unshift({
      operationId,
      toolName: sanitizeText(input.toolName, 80),
      title: sanitizeText(input.title, 160),
      reason: input.reason ? sanitizeText(input.reason, 240) : null,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      targets: sanitizeTargets(input.targets ?? []),
      fileCount: null,
      editCount: null,
      checkpointId: null,
      errorCode: null,
    });
    this.#entries.splice(this.#limit);
    this.#emit();
    this.#replace(operationId, { status: "running" });

    try {
      const result = await operation();
      const completion = summarize(result);
      this.#replace(operationId, {
        status: completion.status ?? "succeeded",
        completedAt: new Date().toISOString(),
        targets: sanitizeTargets(completion.targets ?? this.#find(operationId)?.targets ?? []),
        fileCount: completion.fileCount ?? null,
        editCount: completion.editCount ?? null,
        checkpointId: completion.checkpointId ?? null,
      });
      return result;
    } catch (error) {
      this.#replace(operationId, {
        status: error instanceof BridgeError ? "rejected" : "failed",
        completedAt: new Date().toISOString(),
        errorCode: error instanceof BridgeError ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }
  }

  #find(operationId: string): AgentActivityEntry | undefined {
    return this.#entries.find((entry) => entry.operationId === operationId);
  }

  #replace(operationId: string, update: Partial<AgentActivityEntry>): void {
    const index = this.#entries.findIndex((entry) => entry.operationId === operationId);
    if (index < 0) {
      return;
    }
    this.#entries[index] = { ...this.#entries[index]!, ...update };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function sanitizeText(value: string, limit: number): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return (sanitized || "Agent operation").slice(0, limit);
}

function sanitizeTargets(values: readonly string[]): string[] {
  return [...new Set(values.map(sanitizeTarget).filter((value) => value.length > 0))].slice(0, 50);
}

function sanitizeTarget(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  if (/^[a-zA-Z]:\//u.test(normalized) || normalized.startsWith("/")) {
    return path.basename(normalized);
  }
  if (normalized.startsWith("file:")) {
    try {
      return path.posix.basename(new URL(normalized).pathname);
    } catch {
      return "document";
    }
  }
  return sanitizeText(normalized, 200);
}
