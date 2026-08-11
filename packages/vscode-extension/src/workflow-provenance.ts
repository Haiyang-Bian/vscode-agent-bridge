import type * as vscode from "vscode";

export type WorkflowProvenanceKind = "task" | "debug";

export interface WorkflowProvenanceEntry {
  readonly kind: WorkflowProvenanceKind;
  readonly preparedId: string;
  readonly rootUri: string;
  readonly name: string;
  readonly definitionFingerprint: string;
  readonly configurationSha256: string;
  readonly createdAt: string;
  readonly taskBindings?: WorkflowTaskBindings;
}

export interface WorkflowTaskBinding {
  readonly taskId: string;
  readonly expectedFingerprint: string;
}

export interface WorkflowTaskBindings {
  readonly preLaunchTask: WorkflowTaskBinding | null;
  readonly postDebugTask: WorkflowTaskBinding | null;
}

const STORAGE_KEY = "vscodeAgentBridge.workflowProvenance.v1";
const MAX_ENTRIES = 500;

export class WorkflowProvenanceStore {
  readonly #state: vscode.Memento;
  #queue = Promise.resolve();

  constructor(state: vscode.Memento) {
    this.#state = state;
  }

  entries(kind: WorkflowProvenanceKind, rootUri: string): readonly WorkflowProvenanceEntry[] {
    return this.#read().filter((entry) => entry.kind === kind && entry.rootUri === rootUri);
  }

  find(
    kind: WorkflowProvenanceKind,
    rootUri: string,
    name: string,
    definitionFingerprint?: string,
  ): WorkflowProvenanceEntry | null {
    return this.#read().find(
      (entry) =>
        entry.kind === kind &&
        entry.rootUri === rootUri &&
        entry.name === name &&
        (!definitionFingerprint || entry.definitionFingerprint === definitionFingerprint),
    ) ?? null;
  }

  record(entry: WorkflowProvenanceEntry): Promise<void> {
    return this.recordConfigurationWrite(entry, undefined);
  }

  recordConfigurationWrite(
    entry: WorkflowProvenanceEntry,
    expectedPreviousSha256: string | null | undefined,
  ): Promise<void> {
    const operation = this.#queue
      .catch(() => undefined)
      .then(async () => {
        const rebased = this.#read().map((candidate) =>
          expectedPreviousSha256 !== undefined &&
          candidate.kind === entry.kind &&
          candidate.rootUri === entry.rootUri &&
          candidate.configurationSha256 === expectedPreviousSha256
            ? { ...candidate, configurationSha256: entry.configurationSha256 }
            : candidate,
        );
        const retained = rebased.filter(
          (candidate) =>
            !(
              candidate.kind === entry.kind &&
              candidate.rootUri === entry.rootUri &&
              candidate.name === entry.name
            ),
        );
        retained.push(entry);
        await this.#state.update(STORAGE_KEY, retained.slice(-MAX_ENTRIES));
      });
    this.#queue = operation;
    return operation;
  }

  #read(): WorkflowProvenanceEntry[] {
    const raw = this.#state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry).slice(-MAX_ENTRIES);
  }
}

function isEntry(value: unknown): value is WorkflowProvenanceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.kind === "task" || entry.kind === "debug") &&
    typeof entry.preparedId === "string" &&
    typeof entry.rootUri === "string" &&
    typeof entry.name === "string" &&
    typeof entry.definitionFingerprint === "string" &&
    typeof entry.configurationSha256 === "string" &&
    typeof entry.createdAt === "string" &&
    (entry.taskBindings === undefined || isTaskBindings(entry.taskBindings))
  );
}

function isTaskBindings(value: unknown): value is WorkflowTaskBindings {
  if (!value || typeof value !== "object") return false;
  const bindings = value as Record<string, unknown>;
  return isTaskBindingOrNull(bindings.preLaunchTask) && isTaskBindingOrNull(bindings.postDebugTask);
}

function isTaskBindingOrNull(value: unknown): value is WorkflowTaskBinding | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.taskId === "string" && typeof binding.expectedFingerprint === "string";
}
